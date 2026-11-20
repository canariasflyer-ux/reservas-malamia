/* Lógica compartida entre el servidor y el navegador.
   El servidor la usa para calcular el precio real (nunca se fía del navegador). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Reservados y mesas. Coordenadas (x, y = centro; w, h) sobre la imagen plano.png de 465 x 730.
     min = mínimo de personas por defecto (el administrador puede cambiarlo). */
  var RESERVADOS = [
    { id: 'djd', nombre: 'Reservado Tarima DJ Derecha' },
    { id: 'dji', nombre: 'Reservado Tarima DJ Izquierda' },
    { id: 'esp', nombre: 'Reservado Espejo' },
    { id: 'esc', nombre: 'Reservado Escalera' },
    { id: 't3', nombre: 'Reservado Tarima 3' },
    { id: 't4', nombre: 'Reservado Tarima 4' },
    { id: 't5', nombre: 'Reservado Tarima 5' },
    { id: 't6', nombre: 'Reservado Tarima 6' }
  ];
  var S = 34; // tamaño de una mesa normal en el plano
  function m(res, n, x, y, w, h, min) {
    return { id: res + '-' + n, reservado: res, num: n, x: x, y: y, w: w || S, h: h || S, min: min || 5 };
  }
  var MESAS = [
    m('djd', 4, 92, 24), m('djd', 3, 173, 24), m('djd', 5, 92, 118), m('djd', 1, 173, 118),
    m('dji', 4, 236, 24), m('dji', 3, 313, 24), m('dji', 1, 236, 118), m('dji', 2, 313, 118),
    m('esp', 2, 396, 58), m('esp', 1, 446, 124),
    m('esc', 1, 391, 425, 36, 36, 10),
    m('t6', 1, 45, 425), m('t6', 2, 42, 468),
    m('t5', 1, 45, 519), m('t5', 2, 69, 566),
    m('t4', 1, 110, 625, 36, 70, 10), m('t4', 3, 185, 634, 36, 66, 10), m('t4', 2, 151, 704),
    m('t3', 1, 225, 635, 36, 70, 10), m('t3', 3, 303, 635, 36, 66, 10), m('t3', 2, 259, 704)
  ];
  function mesaPorId(id) { for (var i = 0; i < MESAS.length; i++) if (MESAS[i].id === id) return MESAS[i]; return null; }
  function reservadoPorId(id) { for (var i = 0; i < RESERVADOS.length; i++) if (RESERVADOS[i].id === id) return RESERVADOS[i]; return null; }
  function nombreMesa(id) {
    var t = mesaPorId(id); if (!t) return id;
    return reservadoPorId(t.reservado).nombre + (t.reservado === 'esc' ? '' : ' · Mesa ' + t.num);
  }

  var AJUSTES_DEF = {
    whatsapp: '', iban: '', titular: 'Malamia', bizum: '',
    entradaPrecio: 15,
    entradaTitulo: 'ENTRADA PREVENTA',
    entradaDesc: 'CONSUMISIÓN + CHUPITO + NO ESPERAS COLA',
    personasPorBotella: 5, refrescosPorBotella: 12, maxPersonasMesa: 30,
    mostrarNuevoShisha: true
  };

  var cents = function (x) { return Math.round(Number(x) * 100); };
  var eurosDeCents = function (c) { return c / 100; };
  function entero(v) { var n = Number(v); return Number.isInteger(n) ? n : NaN; }

  /* Mínimo efectivo de una mesa para una fecha: día concreto > permanente > valor por defecto. */
  function minimoMesa(estado, fecha, id) {
    var dia = estado.minimosDia && estado.minimosDia[fecha];
    if (dia && Number.isInteger(dia[id])) return dia[id];
    if (estado.minimosBase && Number.isInteger(estado.minimosBase[id])) return estado.minimosBase[id];
    return mesaPorId(id).min;
  }

  /* Máximo efectivo de una mesa: día concreto > permanente > el doble del mínimo. Nunca baja del mínimo. */
  function maximoMesa(estado, fecha, id) {
    var min = minimoMesa(estado, fecha, id);
    var dia = estado.maximosDia && estado.maximosDia[fecha];
    if (dia && Number.isInteger(dia[id])) return Math.max(min, dia[id]);
    if (estado.maximosBase && Number.isInteger(estado.maximosBase[id])) return Math.max(min, estado.maximosBase[id]);
    return min * 2;
  }

  /* Un día admite reservas si es martes, viernes o sábado, salvo que el administrador lo cierre,
     o si el administrador lo ha abierto expresamente. */
  function diaAbierto(dias, fecha) {
    dias = dias || {};
    var ab = dias.abiertos || [], ce = dias.cerrados || [];
    if (ab.indexOf(fecha) > -1) return true;
    if (ce.indexOf(fecha) > -1) return false;
    var p = fecha.split('-').map(Number);
    var wd = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); // 0 domingo
    return wd === 2 || wd === 5 || wd === 6;
  }

  /* cfg = { ajustes, articulos:{botellas,refrescos,shishas}, minimos:{mesaId:n} }
     pedido = { tipo:'entrada', cantidad } | { tipo:'reservado', mesas:[{id,personas}], botellas:{id:n}, refrescos:{id:n}, shishas:{id:n} } */
  function calcular(cfg, pedido) {
    var A = Object.assign({}, AJUSTES_DEF, cfg.ajustes || {});
    var errores = [], lineas = [];
    if (!pedido || (pedido.tipo !== 'entrada' && pedido.tipo !== 'reservado')) {
      return { ok: false, errores: ['Pedido no válido'], lineas: [], total: 0, personas: 0 };
    }

    if (pedido.tipo === 'entrada') {
      var q = entero(pedido.cantidad);
      if (!(q >= 1 && q <= 30)) errores.push('Elige entre 1 y 30 entradas.');
      var c = cents(A.entradaPrecio) * (q >= 1 ? q : 0);
      if (q >= 1) lineas.push({ txt: q + ' × ' + A.entradaTitulo, importe: eurosDeCents(c) });
      return { ok: !errores.length, errores: errores, lineas: lineas, total: eurosDeCents(c), personas: q >= 1 ? q : 0 };
    }

    var mesas = Array.isArray(pedido.mesas) ? pedido.mesas : [];
    var vistos = {}, personas = 0, botellasMin = 0, mesasOk = [];
    if (!mesas.length) errores.push('Elige al menos una mesa.');
    mesas.forEach(function (it) {
      var t = it && mesaPorId(it.id);
      if (!t) { errores.push('Mesa no válida.'); return; }
      if (vistos[it.id]) { errores.push('Mesa repetida.'); return; }
      vistos[it.id] = 1;
      var p = entero(it.personas);
      var min = cfg.minimos && Number.isInteger(cfg.minimos[it.id]) ? cfg.minimos[it.id] : t.min;
      if (!(p >= min)) errores.push(nombreMesa(it.id) + ': mínimo ' + min + ' personas.');
      else if (p > (cfg.maximos && Number.isInteger(cfg.maximos[it.id]) ? cfg.maximos[it.id] : min * 2)) errores.push(nombreMesa(it.id) + ': máximo ' + (cfg.maximos && Number.isInteger(cfg.maximos[it.id]) ? cfg.maximos[it.id] : min * 2) + ' personas.');
      else {
        personas += p;
        var b = Math.max(1, Math.ceil(p / A.personasPorBotella));
        botellasMin += b;
        mesasOk.push({ id: it.id, personas: p, botellas: b });
      }
    });

    var total = 0;
    function recoger(lista, sel, etiqueta) {
      var out = [];
      Object.keys(sel || {}).forEach(function (id) {
        var n = entero(sel[id]);
        if (n === 0) return;
        var art = (lista || []).filter(function (a) { return a.id === id; })[0];
        if (!art || !art.activo || !(n >= 1 && n <= 99)) { errores.push(etiqueta + ' no disponible.'); return; }
        out.push({ art: art, n: n });
      });
      return out;
    }
    var bot = recoger(cfg.articulos.botellas, pedido.botellas, 'Una botella');
    var ref = recoger(cfg.articulos.refrescos, pedido.refrescos, 'Un refresco');
    var shi = recoger(cfg.articulos.shishas, pedido.shishas, 'Una shisha');

    var nBot = bot.reduce(function (t, i) { return t + i.n; }, 0);
    if (nBot < botellasMin) errores.push('Necesitas al menos ' + botellasMin + (botellasMin === 1 ? ' botella' : ' botellas') + ' para estas mesas.');

    bot.forEach(function (i) { var c = cents(i.art.precio) * i.n; total += c; lineas.push({ txt: i.n + ' × ' + i.art.nombre, importe: eurosDeCents(c) }); });

    /* Refrescos: cada botella incluye N refrescos. Dentro de ese cupo solo se paga el suplemento
       (Aperol, Red Bull...). Lo que pasa del cupo se cobra al precio del refresco.
       El cupo se aplica primero a los refrescos más caros, así el cliente paga siempre lo mínimo. */
    var cupo = nBot * A.refrescosPorBotella;
    var unidades = [];
    ref.forEach(function (i) { for (var k = 0; k < i.n; k++) unidades.push(i.art); });
    unidades.sort(function (a, b) { return cents(b.precio) - cents(a.precio); });
    var usados = Math.min(cupo, unidades.length), supl = 0, extra = 0;
    unidades.forEach(function (a, idx) { if (idx < cupo) supl += cents(a.suplemento || 0); else extra += cents(a.precio); });
    var resumenRef = {};
    ref.forEach(function (i) { resumenRef[i.art.id] = i.n; });
    var nRef = unidades.length;
    var hayRef = (cfg.articulos.refrescos || []).some(function (a) { return a.activo; });
    if (hayRef && nRef < cupo) errores.push('Elige los ' + cupo + ' refrescos incluidos (te ' + (cupo - nRef === 1 ? 'falta 1' : 'faltan ' + (cupo - nRef)) + ').');
    total += supl + extra;
    var refLineas = ref.map(function (i) { return { nombre: i.art.nombre, n: i.n }; });
    if (usados > 0) lineas.push({ txt: usados + ' refrescos incluidos', importe: 0, incluido: true });
    if (supl > 0) lineas.push({ txt: 'Suplemento (Aperol, Red Bull…)', importe: eurosDeCents(supl) });
    if (nRef > cupo) lineas.push({ txt: (nRef - cupo) + ' refrescos extra', importe: eurosDeCents(extra) });

    shi.forEach(function (i) { var c = cents(i.art.precio) * i.n; total += c; lineas.push({ txt: i.n + ' × Shisha ' + i.art.nombre, importe: eurosDeCents(c), shisha: true }); });

    return {
      ok: !errores.length, errores: errores, lineas: lineas, total: eurosDeCents(total), personas: personas,
      mesas: mesasOk, botellasMin: botellasMin, botellasSel: nBot,
      refrescos: { total: nRef, cupo: cupo, usados: usados, extra: Math.max(0, nRef - cupo), suplementos: eurosDeCents(supl), extras: eurosDeCents(extra), items: refLineas },
      botellasDet: bot.map(function (i) { return { nombre: i.art.nombre, n: i.n, precio: i.art.precio }; }),
      shishasDet: shi.map(function (i) { return { nombre: i.art.nombre, n: i.n, precio: i.art.precio }; })
    };
  }

  return {
    RESERVADOS: RESERVADOS, MESAS: MESAS, AJUSTES_DEF: AJUSTES_DEF,
    mesaPorId: mesaPorId, reservadoPorId: reservadoPorId, nombreMesa: nombreMesa,
    minimoMesa: minimoMesa, maximoMesa: maximoMesa, diaAbierto: diaAbierto, calcular: calcular
  };
});
