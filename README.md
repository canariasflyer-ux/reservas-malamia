# Reservas Malamia

Aplicación web de reservas para Malamia: página de clientes (`/`) y panel del administrador (`/admin`).
No necesita instalar nada más que Node.js 18 o superior (sin dependencias).

## Probarla en tu ordenador
```
ADMIN_PASSWORD="tu-clave-segura" node server.js
```
Abre http://localhost:3000 (clientes) y http://localhost:3000/admin (panel).

## Ponerla en internet
Necesitas un hosting que ejecute Node (Render, Railway, Fly.io, un VPS...). Pasos generales:
1. Sube esta carpeta (o conecta el repositorio).
2. Comando de arranque: `node server.js`.
3. Variables de entorno: `ADMIN_PASSWORD` (obligatoria) y, si quieres, `PORT`.
4. IMPORTANTE: guarda la carpeta de datos en un disco persistente. Pon `DATA_DIR` apuntando a ese disco
   (por ejemplo `/var/data`). Ahí se guardan las reservas y los comprobantes. Sin disco persistente se pierden al reiniciar.
5. Usa HTTPS (lo dan por defecto Render, Railway y Fly.io).

Copia de seguridad: guarda de vez en cuando la carpeta `DATA_DIR` (contiene `datos.json` y `uploads/`).

## Primeros pasos en el panel (/admin)
1. Ajustes: número de WhatsApp del local, titular, IBAN y teléfono de Bizum. Hasta que no pongas el WhatsApp, los clientes no pueden enviar reservas.
2. Artículos: cambia los precios. Los que vienen son de ejemplo.
3. Mesas: ajusta el mínimo y el máximo de personas de cada mesa (permanente o solo un día). Si no cambias el máximo, es el doble del mínimo.
4. Reservas: abre un día que no sea martes, viernes o sábado desde su ficha del calendario.

## Cómo funciona el flujo
- El cliente elige fecha, entrada de preventa o reservado, paga por transferencia/Bizum, adjunta el comprobante y pulsa "Enviar reserva por WhatsApp".
- Una mesa que alguien está reservando se ve en amarillo para los demás, pero se puede pedir igualmente. Se la queda quien envía primero la reserva con el comprobante; a la otra persona la página le avisa de que esa mesa acaba de ser reservada.
- Para pasar al pago hay que elegir todos los refrescos incluidos en las botellas (12 por botella).
- La reserva aparece en el panel con su comprobante. Tú validas o rechazas y se abre WhatsApp con el mensaje al cliente.
- Si rechazas una reserva, sus mesas quedan libres.

## Límite importante de WhatsApp
Los mensajes no se envían solos: se abre WhatsApp con el texto escrito y hay que pulsar Enviar (el cliente al avisar al local, y tú al responder al cliente).
Para envíos automáticos haría falta la API de WhatsApp Business (de pago y con alta en Meta).

## Datos que debes revisar
- Tarima 6 tiene 2 mesas en el plano; Tarima 5 tiene 2; Escalera 1.
- Mesas dobles (10 personas mínimo): Tarima 3 mesas 1 y 3, Tarima 4 mesas 1 y 3, y Escalera.
- Refrescos: cada botella incluye 12. Dentro de los incluidos solo se cobra el suplemento (Aperol y Red Bull, 1 €).
  Los que pasan del cupo se cobran a su precio, empezando por los más caros que haya pedido el cliente que entren en el cupo
  (así el cliente siempre paga lo mínimo).
