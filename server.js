'use strict';
/* Reservas Malamia — servidor sin dependencias (solo Node 18 o superior).
   Variables de entorno:
     ADMIN_PASSWORD  (obligatoria) contraseña del panel de administración
     PORT            puerto (por defecto 3000)
     DATA_DIR        carpeta donde se guardan reservas y comprobantes (por defecto ./data)  */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Shared = require('./lib/shared.js');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOADS = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'datos.json');
const PUBLIC = path.join(__dirname, 'public');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (ADMIN_PASSWORD.length < 6) {
  console.error('Falta ADMIN_PASSWORD (mínimo 6 caracteres). Ejemplo: ADMIN_PASSWORD="mi-clave-segura" node server.js');
  process.exit(1);
}
fs.mkdirSync(UPLOADS, { recursive: true });

const HOLD_MS = 12 * 60 * 1000;          // una mesa elegida se reserva 12 min mientras el cliente completa el pago
const MAX_BODY = 22 * 1024 * 1024;
const MAX_FILE = 8 * 1024 * 1024;

/* ---------------- datos ---------------- */
const ARTICULOS_DEF = {
  botellas: [
    { id: 'b1', nombre: 'Vodka Absolut', precio: 120, activo: true },
    { id: 'b2', nombre: 'Ron Brugal', precio: 110, activo: true },
    { id: 'b3', nombre: 'Ginebra Beefeater', precio: 120, activo: true },
    { id: 'b4', nombre: "Whisky Jack Daniel's", precio: 150, activo: true },
    { id: 'b5', nombre: 'Tequila José Cuervo', precio: 130, activo: true }
  ],
  refrescos: [
    { id: 'r1', nombre: 'Coca-Cola', precio: 4, suplemento: 0, activo: true },
    { id: 'r2', nombre: 'Fanta naranja', precio: 4, suplemento: 0, activo: true },
    { id: 'r3', nombre: 'Sprite', precio: 4, suplemento: 0, activo: true },
    { id: 'r4', nombre: 'Tónica', precio: 4, suplemento: 0, activo: true },
    { id: 'r5', nombre: 'Agua', precio: 3, suplemento: 0, activo: true },
    { id: 'r6', nombre: 'Red Bull', precio: 5, suplemento: 1, activo: true },
    { id: 'r7', nombre: 'Aperol', precio: 6, suplemento: 1, activo: true }
  ],
  shishas: [
    { id: 's1', nombre: 'Clásica', precio: 20, activo: true },
    { id: 's2', nombre: 'Frutas', precio: 25, activo: true },
    { id: 's3', nombre: 'Premium', precio: 30, activo: true }
  ]
};
let DB = {
  secreto: crypto.randomBytes(32).toString('hex'),
  ajustes: Object.assign({}, Shared.AJUSTES_DEF),
  articulos: ARTICULOS_DEF,
  minimosBase: {},
  minimosDia: {},
  maximosBase: {},
  maximosDia: {},
  dias: { abiertos: [], cerrados: [] },
  bloqueos: [],
  reservas: []
};
try {
  const l = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  DB = Object.assign(DB, l);
  DB.ajustes = Object.assign({}, Shared.AJUSTES_DEF, l.ajustes || {});
} catch (e) { /* primera vez */ }

let guardando = false, pendiente = false;
function guardar() {
  if (guardando) { pendiente = true; return; }
  guardando = true;
  const tmp = DB_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(DB), (e) => {
    if (e) { guardando = false; console.error('No se pudo guardar:', e.message); return; }
    fs.rename(tmp, DB_FILE, (e2) => {
      if (e2) console.error('No se pudo guardar:', e2.message);
      guardando = false;
      if (pendiente) { pendiente = false; guardar(); }
    });
  });
}
guardar();

/* ---------------- utilidades ---------------- */
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Atlantic/Canary' }).format(new Date());
const esFecha = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T12:00:00Z'));
const limpio = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const telefono = (s) => { let d = String(s || '').replace(/\D/g, ''); if (d.indexOf('00') === 0) d = d.slice(2); if (d.length === 9) d = '34' + d; return d; };
const num = (v, def) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : def; };
function codigoNuevo() {
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = 'MM-';
    for (let i = 0; i < 4; i++) c += a[crypto.randomInt(a.length)];
    if (!DB.reservas.some((r) => r.codigo === c)) return c;
  }
}
const ocupa = (r) => r.estado !== 'rechazada';

/* mesas que un cliente está reservando ahora (se ven en amarillo para los demás).
   No bloquean: varias personas pueden intentar la misma mesa; se la queda quien envía antes la reserva con el comprobante. */
const holds = new Map();
function limpiarHolds() { const t = Date.now(); for (const [k, v] of holds) if (v.hasta < t) holds.delete(k); }
setInterval(limpiarHolds, 30000).unref();

function estadoMesas(fecha, token) {
  limpiarHolds();
  const ocupadas = new Set();
  DB.reservas.forEach((r) => { if (r.tipo === 'reservado' && r.fecha === fecha && ocupa(r)) r.mesas.forEach((m) => ocupadas.add(m.id)); });
  DB.bloqueos.forEach((b) => { if (b.fecha === fecha) ocupadas.add(b.mesa); });
  const ret = new Set(), pro = new Set();
  for (const v of holds.values()) {
    if (v.fecha !== fecha || ocupadas.has(v.mesa)) continue;
    (v.token === token ? pro : ret).add(v.mesa);
  }
  return { ocupadas: [...ocupadas], retenidas: [...ret].filter((m) => !pro.has(m)), propias: [...pro] };
}
function minimosDe(fecha) {
  const o = {};
  Shared.MESAS.forEach((t) => { o[t.id] = Shared.minimoMesa(DB, fecha, t.id); });
  return o;
}
function maximosDe(fecha) {
  const o = {};
  Shared.MESAS.forEach((t) => { o[t.id] = Shared.maximoMesa(DB, fecha, t.id); });
  return o;
}
function cfgPara(fecha) { return { ajustes: DB.ajustes, articulos: DB.articulos, minimos: minimosDe(fecha), maximos: maximosDe(fecha) }; }

/* ---------------- http ---------------- */
function enviar(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}
function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const trozos = [];
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('Cuerpo demasiado grande'), { code: 413 })); req.destroy(); } else trozos.push(c); });
    req.on('end', () => { try { resolve(trozos.length ? JSON.parse(Buffer.concat(trozos).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('JSON no válido'), { code: 400 })); } });
    req.on('error', reject);
  });
}
const ip = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const limites = new Map();
function limitar(clave, max, ventanaMs) {
  const t = Date.now(); const a = (limites.get(clave) || []).filter((x) => t - x < ventanaMs);
  if (a.length >= max) { limites.set(clave, a); return false; }
  a.push(t); limites.set(clave, a); return true;
}
setInterval(() => { const t = Date.now(); for (const [k, a] of limites) if (!a.some((x) => t - x < 3600000)) limites.delete(k); }, 600000).unref();

/* sesión del administrador: cookie firmada con caducidad */
function firmar(txt) { return crypto.createHmac('sha256', DB.secreto).update(txt).digest('hex'); }
function crearSesion() { const exp = Date.now() + 7 * 24 * 3600 * 1000; return exp + '.' + firmar('adm.' + exp); }
function esAdmin(req) {
  const m = /(?:^|;\s*)adm=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return false;
  const [exp, sig] = m[1].split('.'); if (!exp || !sig || Number(exp) < Date.now()) return false;
  const esperado = firmar('adm.' + exp);
  return sig.length === esperado.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado));
}
function claveOk(p) {
  const a = crypto.createHash('sha256').update(String(p)).digest(), b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

/* archivos subidos: solo imágenes o PDF, comprobando el contenido real */
function tipoArchivo(buf) {
  if (buf.length > 12 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 5 && buf.slice(0, 5).toString() === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

/* ---------------- API pública ---------------- */
function publico(fecha) {
  const A = DB.ajustes;
  const t = hoy();
  const lim = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  return {
    hoy: t,
    ajustes: {
      whatsapp: A.whatsapp, iban: A.iban, titular: A.titular, bizum: A.bizum,
      entradaPrecio: A.entradaPrecio, entradaTitulo: A.entradaTitulo, entradaDesc: A.entradaDesc,
      personasPorBotella: A.personasPorBotella, refrescosPorBotella: A.refrescosPorBotella,
      mostrarNuevoShisha: A.mostrarNuevoShisha
    },
    articulos: {
      botellas: DB.articulos.botellas.filter((a) => a.activo),
      refrescos: DB.articulos.refrescos.filter((a) => a.activo),
      shishas: DB.articulos.shishas.filter((a) => a.activo)
    },
    dias: { abiertos: DB.dias.abiertos.filter((d) => d >= t && d <= lim), cerrados: DB.dias.cerrados.filter((d) => d >= t && d <= lim) },
    minimos: fecha && esFecha(fecha) ? minimosDe(fecha) : null,
    maximos: fecha && esFecha(fecha) ? maximosDe(fecha) : null
  };
}

function crearReserva(body, req) {
  const fecha = body.pedido && body.pedido.fecha;
  if (!esFecha(fecha) || fecha < hoy()) return [400, { error: 'La fecha no es válida.' }];
  if (!Shared.diaAbierto(DB.dias, fecha)) return [400, { error: 'Ese día no admite reservas.' }];
  const nombre = limpio(body.nombre, 60), tel = limpio(body.telefono, 25);
  if (nombre.length < 2) return [400, { error: 'Escribe tu nombre.' }];
  if (telefono(tel).length < 10) return [400, { error: 'Escribe un teléfono válido.' }];
  const token = limpio(body.token, 80);

  const p = body.pedido;
  const entrada = p.tipo === 'entrada';
  const pedido = entrada ? { tipo: 'entrada', cantidad: p.cantidad } :
    { tipo: 'reservado', mesas: p.mesas, botellas: p.botellas, refrescos: p.refrescos, shishas: p.shishas };
  const calc = Shared.calcular(cfgPara(fecha), pedido);
  if (!calc.ok) return [400, { error: calc.errores[0] }];

  const arch = Array.isArray(body.comprobantes) ? body.comprobantes : [];
  if (!arch.length) return [400, { error: 'Adjunta el comprobante de pago.' }];
  if (arch.length > 3) return [400, { error: 'Puedes adjuntar hasta 3 archivos.' }];
  const decod = [];
  for (const a of arch) {
    let buf; try { buf = Buffer.from(String(a && a.datos || ''), 'base64'); } catch (e) { buf = Buffer.alloc(0); }
    if (!buf.length || buf.length > MAX_FILE) return [400, { error: 'Cada archivo debe pesar menos de 8 MB.' }];
    const tipo = tipoArchivo(buf);
    if (!tipo) return [400, { error: 'Solo se admiten imágenes (JPG, PNG, WEBP) o PDF.' }];
    decod.push({ buf, tipo, nombre: limpio(a.nombre, 80) });
  }

  let mesas = [];
  if (!entrada) {
    /* Gana quien envía antes la reserva con el comprobante. Comprobación y reserva en el mismo paso,
       así que no puede haber dos compradores. Que otro la esté mirando (amarillo) no impide reservarla. */
    const est = estadoMesas(fecha, token);
    const ocup = calc.mesas.filter((m) => est.ocupadas.includes(m.id));
    if (ocup.length) return [409, { error: (ocup.length === 1 ? 'Esa mesa acaba de ser reservada: ' : 'Esas mesas acaban de ser reservadas: ') + ocup.map((m) => Shared.nombreMesa(m.id)).join(', ') + '. Elige otra.', ocupadas: ocup.map((m) => m.id) }];
    mesas = calc.mesas.map((m) => ({ id: m.id, nombre: Shared.nombreMesa(m.id), personas: m.personas, botellas: m.botellas }));
  }

  const id = crypto.randomBytes(8).toString('hex');
  const guardados = decod.map((d, i) => {
    const f = id + '-' + i + '.' + d.tipo.ext;
    fs.writeFileSync(path.join(UPLOADS, f), d.buf);
    return { file: f, nombre: d.nombre || ('comprobante' + (i + 1) + '.' + d.tipo.ext), mime: d.tipo.mime };
  });
  const r = {
    id, codigo: codigoNuevo(), tipo: pedido.tipo, fecha, nombre, telefono: tel, estado: 'pendiente',
    creada: new Date().toISOString(), personas: calc.personas, total: calc.total, comprobantes: guardados
  };
  if (entrada) r.cantidad = Number(pedido.cantidad);
  else {
    r.mesas = mesas; r.botellas = calc.botellasDet; r.refrescos = calc.refrescos; r.shishas = calc.shishasDet;
  }
  DB.reservas.push(r);
  for (const [k, v] of holds) if (v.fecha === fecha && mesas.some((m) => m.id === v.mesa)) holds.delete(k);
  guardar();
  return [200, { ok: true, codigo: r.codigo, mensaje: mensajeDueno(r) }];
}

const eur = (n) => (Number.isInteger(n) ? n + ' €' : n.toFixed(2).replace('.', ',') + ' €');
const fechaTxt = (f) => new Date(f + 'T12:00:00Z').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
function mensajeDueno(r) {
  let m = 'NUEVA RESERVA MALAMIA\nCódigo: ' + r.codigo + '\nNombre: ' + r.nombre + '\nTeléfono: ' + r.telefono + '\nFecha: ' + fechaTxt(r.fecha) + '\n';
  if (r.tipo === 'entrada') m += 'Entradas preventa: ' + r.cantidad + '\n';
  else {
    m += 'Mesas:\n' + r.mesas.map((x) => '- ' + x.nombre + ' (' + x.personas + ' pers.)').join('\n') + '\n';
    m += 'Botellas: ' + r.botellas.map((b) => b.n + 'x ' + b.nombre).join(', ') + '\n';
    if (r.refrescos && r.refrescos.items.length) m += 'Refrescos: ' + r.refrescos.items.map((b) => b.n + 'x ' + b.nombre).join(', ') + '\n';
    if (r.shishas.length) m += 'Shishas: ' + r.shishas.map((b) => b.n + 'x ' + b.nombre).join(', ') + '\n';
  }
  return m + 'Total pagado: ' + eur(r.total) + '\nEl comprobante está adjunto en la app (código ' + r.codigo + ').';
}

/* ---------------- API admin ---------------- */
function validarArticulos(a) {
  const salida = {};
  for (const k of ['botellas', 'refrescos', 'shishas']) {
    if (!Array.isArray(a && a[k])) throw new Error('Datos de artículos no válidos.');
    const ids = new Set();
    salida[k] = a[k].slice(0, 200).map((x) => {
      let id = limpio(x.id, 30).replace(/[^\w-]/g, '') || ('x' + crypto.randomBytes(4).toString('hex'));
      while (ids.has(id)) id += 'x';
      ids.add(id);
      const nombre = limpio(x.nombre, 60); if (!nombre) throw new Error('Todos los artículos necesitan nombre.');
      const precio = num(x.precio, NaN); if (!(precio >= 0 && precio <= 100000)) throw new Error('Precio no válido en "' + nombre + '".');
      const o = { id, nombre, precio: Math.round(precio * 100) / 100, activo: !!x.activo };
      if (k === 'refrescos') { const s = num(x.suplemento || 0, 0); o.suplemento = s >= 0 && s <= 1000 ? Math.round(s * 100) / 100 : 0; }
      return o;
    });
  }
  return salida;
}
function rutaAdmin(req, res, url, body) {
  const m = req.method, p = url.pathname;
  if (m === 'GET' && p === '/api/admin/estado') {
    return [200, {
      hoy: hoy(), ajustes: DB.ajustes, articulos: DB.articulos, minimosBase: DB.minimosBase, minimosDia: DB.minimosDia, maximosBase: DB.maximosBase, maximosDia: DB.maximosDia,
      dias: DB.dias, bloqueos: DB.bloqueos, reservas: DB.reservas,
      mesas: Shared.MESAS.map((t) => ({ id: t.id, nombre: Shared.nombreMesa(t.id), reservado: t.reservado, min: t.min }))
    }];
  }
  if (m === 'PUT' && p === '/api/admin/articulos') { DB.articulos = validarArticulos(body); guardar(); return [200, { ok: true, articulos: DB.articulos }]; }
  if (m === 'PUT' && p === '/api/admin/ajustes') {
    const A = {};
    A.whatsapp = limpio(body.whatsapp, 25); A.iban = limpio(body.iban, 50); A.titular = limpio(body.titular, 80); A.bizum = limpio(body.bizum, 25);
    A.entradaTitulo = limpio(body.entradaTitulo, 60) || 'ENTRADA PREVENTA'; A.entradaDesc = limpio(body.entradaDesc, 120);
    const pr = num(body.entradaPrecio, NaN); if (!(pr >= 0 && pr <= 1000)) return [400, { error: 'Precio de la entrada no válido.' }]; A.entradaPrecio = pr;
    const ppb = Math.round(num(body.personasPorBotella, 5)), rpb = Math.round(num(body.refrescosPorBotella, 12));
    if (!(ppb >= 1 && ppb <= 50 && rpb >= 0 && rpb <= 100)) return [400, { error: 'Revisa los números de botellas y personas.' }];
    A.personasPorBotella = ppb; A.refrescosPorBotella = rpb; A.mostrarNuevoShisha = !!body.mostrarNuevoShisha;
    DB.ajustes = Object.assign({}, Shared.AJUSTES_DEF, A); guardar(); return [200, { ok: true, ajustes: DB.ajustes }];
  }
  if (m === 'PUT' && p === '/api/admin/minimos') {
    const fecha = body.fecha || null, mesa = limpio(body.mesa, 20), valor = body.valor;
    if (!Shared.mesaPorId(mesa)) return [400, { error: 'Mesa no válida.' }];
    if (fecha && !esFecha(fecha)) return [400, { error: 'Fecha no válida.' }];
    /* valor = mínimo; max = máximo (null = automático, el doble del mínimo). valor null = volver al original. */
    const poner = (base, dia, v) => {
      if (fecha) {
        if (v === null) { if (dia[fecha]) { delete dia[fecha][mesa]; if (!Object.keys(dia[fecha]).length) delete dia[fecha]; } }
        else (dia[fecha] = dia[fecha] || {})[mesa] = v;
      } else if (v === null) delete base[mesa]; else base[mesa] = v;
    };
    if (valor === null) { poner(DB.minimosBase, DB.minimosDia, null); poner(DB.maximosBase, DB.maximosDia, null); }
    else {
      const v = Math.round(num(valor, NaN)); if (!(v >= 1 && v <= 100)) return [400, { error: 'El mínimo debe estar entre 1 y 100.' }];
      const mx = body.max === null || body.max === undefined || body.max === '' ? null : Math.round(num(body.max, NaN));
      if (mx !== null && !(mx >= v && mx <= 200)) return [400, { error: 'El máximo no puede ser menor que el mínimo (ni superar 200).' }];
      poner(DB.minimosBase, DB.minimosDia, v); poner(DB.maximosBase, DB.maximosDia, mx);
    }
    guardar(); return [200, { ok: true, minimosBase: DB.minimosBase, minimosDia: DB.minimosDia, maximosBase: DB.maximosBase, maximosDia: DB.maximosDia }];
  }
  if (m === 'PUT' && p === '/api/admin/dia') {
    const f = body.fecha; if (!esFecha(f)) return [400, { error: 'Fecha no válida.' }];
    const abierto = !!body.abierto, natural = [2, 5, 6].includes(new Date(f + 'T12:00:00Z').getUTCDay());
    DB.dias.abiertos = DB.dias.abiertos.filter((d) => d !== f); DB.dias.cerrados = DB.dias.cerrados.filter((d) => d !== f);
    if (abierto && !natural) DB.dias.abiertos.push(f);
    if (!abierto && natural) DB.dias.cerrados.push(f);
    guardar(); return [200, { ok: true, dias: DB.dias }];
  }
  if (m === 'PUT' && p === '/api/admin/bloqueo') {
    const f = body.fecha, mesa = limpio(body.mesa, 20);
    if (!esFecha(f) || !Shared.mesaPorId(mesa)) return [400, { error: 'Datos no válidos.' }];
    const ocupada = DB.reservas.some((r) => r.tipo === 'reservado' && r.fecha === f && ocupa(r) && r.mesas.some((x) => x.id === mesa));
    DB.bloqueos = DB.bloqueos.filter((b) => !(b.fecha === f && b.mesa === mesa));
    if (body.bloqueada) { if (ocupada) return [409, { error: 'Esa mesa ya tiene una reserva.' }]; DB.bloqueos.push({ fecha: f, mesa }); }
    guardar(); return [200, { ok: true, bloqueos: DB.bloqueos }];
  }
  let mm;
  if (m === 'PUT' && (mm = /^\/api\/admin\/reservas\/([a-f0-9]+)\/estado$/.exec(p))) {
    const r = DB.reservas.find((x) => x.id === mm[1]); if (!r) return [404, { error: 'No existe.' }];
    if (!['pendiente', 'validada', 'rechazada'].includes(body.estado)) return [400, { error: 'Estado no válido.' }];
    if (body.estado !== 'rechazada' && r.estado === 'rechazada' && r.tipo === 'reservado') {
      const est = estadoMesas(r.fecha, '');
      if (r.mesas.some((x) => est.ocupadas.includes(x.id))) return [409, { error: 'Alguna de sus mesas ya está ocupada por otra reserva.' }];
    }
    r.estado = body.estado; r.revisada = new Date().toISOString(); guardar(); return [200, { ok: true }];
  }
  if (m === 'DELETE' && (mm = /^\/api\/admin\/reservas\/([a-f0-9]+)$/.exec(p))) {
    const i = DB.reservas.findIndex((x) => x.id === mm[1]); if (i < 0) return [404, { error: 'No existe.' }];
    DB.reservas[i].comprobantes.forEach((c) => fs.unlink(path.join(UPLOADS, c.file), () => {}));
    DB.reservas.splice(i, 1); guardar(); return [200, { ok: true }];
  }
  return null;
}

/* ---------------- servidor ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const CAB = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };

function estatico(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  if (p === '/shared.js') { res.writeHead(200, Object.assign({ 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' }, CAB)); return res.end(fs.readFileSync(path.join(__dirname, 'lib', 'shared.js'))); }
  const f = path.normalize(path.join(PUBLIC, p));
  if (!f.startsWith(PUBLIC + path.sep) || path.basename(f).startsWith('_')) { res.writeHead(404, CAB); return res.end('No encontrado'); }
  fs.readFile(f, (e, data) => {
    if (e) { res.writeHead(404, CAB); return res.end('No encontrado'); }
    const ext = path.extname(f);
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache' }, CAB));
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname, m = req.method;
    if (!p.startsWith('/api/')) return estatico(req, res, url);

    if (m === 'GET' && p === '/api/publico') return enviar(res, 200, publico(url.searchParams.get('fecha')));
    if (m === 'GET' && p === '/api/disponibilidad') {
      const f = url.searchParams.get('fecha'); if (!esFecha(f)) return enviar(res, 400, { error: 'Fecha no válida.' });
      return enviar(res, 200, estadoMesas(f, limpio(url.searchParams.get('token'), 80)));
    }
    if (m === 'POST' && p === '/api/retener') {
      if (!limitar('ret:' + ip(req), 120, 600000)) return enviar(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
      const b = await leerCuerpo(req), f = b.fecha, token = limpio(b.token, 80);
      if (!esFecha(f) || f < hoy() || !token || !Array.isArray(b.mesas) || b.mesas.length > 25) return enviar(res, 400, { error: 'Datos no válidos.' });
      if (!Shared.diaAbierto(DB.dias, f)) return enviar(res, 400, { error: 'Ese día no admite reservas.' });
      const ids = b.mesas.filter((x) => Shared.mesaPorId(x));
      const est = estadoMesas(f, token);
      const fuera = ids.filter((x) => est.ocupadas.includes(x));
      if (fuera.length) {                                       // solo impide una mesa ya reservada (o bloqueada), no una que otro está mirando
        return enviar(res, 409, { error: 'Esa mesa acaba de ser reservada por otra persona.', conflicto: fuera, ...est });
      }
      for (const [k, v] of holds) if (v.token === token && v.fecha === f) holds.delete(k);   // soltar las que ya no quiere
      ids.forEach((x) => holds.set(f + '|' + x + '|' + token, { fecha: f, mesa: x, token, hasta: Date.now() + HOLD_MS }));
      return enviar(res, 200, { ok: true, minutos: HOLD_MS / 60000, ...estadoMesas(f, token) });
    }
    if (m === 'POST' && p === '/api/reservas') {
      if (!limitar('res:' + ip(req), 12, 3600000)) return enviar(res, 429, { error: 'Demasiadas reservas desde este dispositivo. Inténtalo más tarde.' });
      const [code, obj] = crearReserva(await leerCuerpo(req), req);
      return enviar(res, code, obj);
    }

    if (m === 'POST' && p === '/api/admin/login') {
      if (!limitar('log:' + ip(req), 10, 900000)) return enviar(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });
      const b = await leerCuerpo(req);
      if (!claveOk(b.password)) return enviar(res, 401, { error: 'Contraseña incorrecta.' });
      const seguro = (req.headers['x-forwarded-proto'] || '') === 'https' || req.socket.encrypted;
      return enviar(res, 200, { ok: true }, { 'Set-Cookie': 'adm=' + crearSesion() + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800' + (seguro ? '; Secure' : '') });
    }
    if (p.startsWith('/api/admin/')) {
      if (m === 'GET' && p === '/api/admin/sesion') return enviar(res, 200, { admin: esAdmin(req) });
      if (m === 'POST' && p === '/api/admin/logout') return enviar(res, 200, { ok: true }, { 'Set-Cookie': 'adm=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
      if (!esAdmin(req)) return enviar(res, 401, { error: 'Sesión no iniciada.' });
      const mm = /^\/api\/admin\/comprobante\/([a-f0-9]+)\/(\d)$/.exec(p);
      if (m === 'GET' && mm) {
        const r = DB.reservas.find((x) => x.id === mm[1]), c = r && r.comprobantes[Number(mm[2])];
        if (!c) { res.writeHead(404, CAB); return res.end('No encontrado'); }
        return fs.readFile(path.join(UPLOADS, c.file), (e, d) => {
          if (e) { res.writeHead(404, CAB); return res.end('No encontrado'); }
          res.writeHead(200, Object.assign({ 'Content-Type': c.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' }, CAB)); res.end(d);
        });
      }
      const body = (m === 'GET' || m === 'DELETE') ? {} : await leerCuerpo(req);
      let out; try { out = rutaAdmin(req, res, url, body); } catch (e) { return enviar(res, 400, { error: e.message }); }
      return out ? enviar(res, out[0], out[1]) : enviar(res, 404, { error: 'No existe.' });
    }
    enviar(res, 404, { error: 'No existe.' });
  } catch (e) {
    if (!res.headersSent) enviar(res, e.code === 413 ? 413 : e.code === 400 ? 400 : 500, { error: e.code === 413 ? 'Archivo demasiado grande.' : e.code === 400 ? 'Datos no válidos.' : 'Error del servidor.' });
    if (!e.code) console.error(e);
  }
});
server.listen(PORT, () => console.log('Reservas Malamia en http://localhost:' + PORT + '  ·  panel: /admin  ·  datos en ' + DATA_DIR));
