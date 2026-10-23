#!/bin/bash
# Reparación ante bucle de reinicios — instalado como
# /usr/local/sbin/expense-tracker-repair, lo corre expense-tracker-repair.service.
#
# En el incidente del 2026-10-07 un archivo de node_modules quedó con bytes
# basura tras el corte de luz: server.js tiraba SyntaxError al hacer
# require() y systemd lo reinició 76 veces sin arreglar nada. La solución a
# mano fue reinstalar las dependencias; esto lo hace solo.
#
# Reglas:
#   - Sin internet no toca nada (npm ci borra node_modules antes de bajar:
#     sin red dejaría la app peor que como estaba). Sale con 1 y systemd
#     reintenta cada 10 min.
#   - Como mucho un intento cada MIN_HORAS. Si el problema no era
#     node_modules (un bug en el código, por ejemplo), npm ci no lo arregla
#     y repetirlo solo gasta la SD. Para eso está el aviso de healthchecks.io.

set -u

APP_DIR=${APP_DIR:-/home/rpi/expense-tracker/rpi}
STATE_DIR=${STATE_DIR:-/var/lib/expense-tracker-repair}
STAMP=$STATE_DIR/ultimo-intento
MIN_HORAS=${MIN_HORAS:-6}
SERVICIO=expense-tracker

log() { echo "[repair] $*"; }

mkdir -p "$STATE_DIR"

# Según la versión de systemd, OnFailure= puede dispararse también en cada
# reinicio automático suelto, no solo al agotar StartLimitBurst. Actuar solo
# si la unidad quedó de verdad en failed.
if [ "${FORZAR:-0}" != 1 ] && ! systemctl is-failed --quiet "$SERVICIO"; then
  log "$SERVICIO no está en failed (reinicio automático suelto) — nada que reparar"
  exit 0
fi

ahora=$(date +%s)
if [ -s "$STAMP" ] && [ $(( ahora - $(cat "$STAMP") )) -lt $(( MIN_HORAS * 3600 )) ]; then
  log "ya hubo un intento hace menos de ${MIN_HORAS} h — no reintento; $SERVICIO queda caído hasta revisarlo a mano"
  exit 0
fi

if ! curl -fsS -m 15 -o /dev/null https://registry.npmjs.org/; then
  log "sin acceso a registry.npmjs.org — no toco node_modules, reintento más tarde"
  exit 1
fi

echo "$ahora" > "$STAMP"
log "$SERVICIO en bucle de reinicios. Últimas líneas del log:"
journalctl -u "$SERVICIO" -n 15 --no-pager 2>/dev/null | sed 's/^/    /'

cd "$APP_DIR" || { log "no existe $APP_DIR"; exit 0; }
NPM=$(command -v npm || echo /usr/bin/npm)
# El servicio corre como root (ver expense-tracker.service), pero el repo es
# del usuario que lo clonó: devolverle node_modules para que un `npm install`
# suyo posterior no choque con archivos de root.
duenio=$(stat -c %U "$APP_DIR")

# La caché de npm vive en la misma SD: si también quedó dañada, npm ci
# reinstalaría los mismos bytes rotos.
if ! "$NPM" cache verify >/dev/null 2>&1; then
  log "caché de npm dañada — limpiándola"
  "$NPM" cache clean --force
fi

log "corriendo npm ci (puede tardar varios minutos)"
if "$NPM" ci --omit=dev --no-audit --no-fund; then
  chown -R "$duenio:$duenio" node_modules
  log "npm ci terminó bien"
else
  log "npm ci falló — levanto el servicio igual, el aviso externo avisará si sigue caído"
fi

systemctl reset-failed "$SERVICIO"
systemctl start --no-block "$SERVICIO"
log "$SERVICIO relanzado"
exit 0
