#!/bin/bash
# Watchdog de red — instalado como /usr/local/sbin/net-watchdog, lo corre
# net-watchdog.timer cada 2 minutos.
#
# Nace del incidente del 2026-10-07: tras un corte de luz el perfil de wifi
# desapareció de NetworkManager y la Pi pasó una semana encendida pero sin
# red, sin que nada lo arreglara. Este script hace tres cosas:
#
#   1. Con red: guarda una copia de los perfiles wifi (solo si cambiaron).
#   2. Sin red y sin perfil wifi: restaura el perfil desde esa copia.
#   3. Sin red, escalando: reconectar → reiniciar NetworkManager → reboot.
#
# "Sin red" = no responde ni el router ni 1.1.1.1 ni 8.8.8.8. Si el router
# responde pero internet no, el problema es del proveedor y reiniciar la Pi
# no lo arregla: no se hace nada.
#
# Los reboots están limitados (MAX_REBOOTS cada REBOOT_WINDOW_H horas) para
# que un router apagado durante horas no deje a la Pi en un bucle de reinicios
# que, además, castiga la SD.
#
# Uso:
#   net-watchdog              un chequeo (lo que hace el timer)
#   net-watchdog --respaldar  solo copia los perfiles wifi actuales
#
# NET_WATCHDOG_DRYRUN=1 registra las acciones sin ejecutarlas.

set -u

STATE_DIR=${STATE_DIR:-/var/lib/net-watchdog}
RUN_DIR=${RUN_DIR:-/run/net-watchdog}
NM_DIR=${NM_DIR:-/etc/NetworkManager/system-connections}
BACKUP_DIR=$STATE_DIR/wifi
# En /run (tmpfs): el contador de fallos vuelve a 0 en cada arranque.
FALLOS_FILE=$RUN_DIR/fallos
# En /var/lib: el historial de reboots sobrevive al reboot, que es la idea.
REBOOTS_FILE=$STATE_DIR/reinicios

# Escalera, en chequeos seguidos sin red (timer de 2 min).
PASO_RECONECTAR=${PASO_RECONECTAR:-2}   # ~4 min
PASO_REINICIAR_NM=${PASO_REINICIAR_NM:-4} # ~8 min
PASO_REBOOT=${PASO_REBOOT:-7}           # ~14 min
MAX_REBOOTS=${MAX_REBOOTS:-3}
REBOOT_WINDOW_H=${REBOOT_WINDOW_H:-6}
DRYRUN=${NET_WATCHDOG_DRYRUN:-0}

log() { echo "[net-watchdog] $*"; }

ejecutar() {
  if [ "$DRYRUN" = 1 ]; then
    log "(dry-run) $*"
  else
    "$@"
  fi
}

hay_red() {
  local gw destino
  gw=$(ip route show default 2>/dev/null | awk '/^default/ {print $3; exit}')
  for destino in $gw 1.1.1.1 8.8.8.8; do
    if ping -c 1 -W 3 "$destino" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

interfaz_wifi() {
  nmcli -t -f DEVICE,TYPE device 2>/dev/null | awk -F: '$2 == "wifi" {print $1; exit}'
}

hay_perfil_wifi() {
  nmcli -t -f TYPE connection show 2>/dev/null | grep -q '^802-11-wireless$'
}

# Copia los perfiles wifi de NetworkManager a BACKUP_DIR. Solo se llama con
# red, así la copia siempre es de un perfil que funciona (si cambiás la clave
# del wifi, la copia se actualiza sola en el siguiente chequeo).
respaldar() {
  local f
  for f in "$NM_DIR"/*.nmconnection; do
    [ -f "$f" ] || continue
    grep -q '^type=wifi' "$f" || continue
    if ! cmp -s "$f" "$BACKUP_DIR/$(basename "$f")"; then
      cp -p "$f" "$BACKUP_DIR/" && chmod 600 "$BACKUP_DIR/$(basename "$f")"
      log "respaldado perfil wifi $(basename "$f")"
    fi
  done
}

restaurar_perfil_si_falta() {
  hay_perfil_wifi && return 0
  local copias
  copias=$(ls "$BACKUP_DIR"/*.nmconnection 2>/dev/null)
  if [ -z "$copias" ]; then
    log "no hay perfil wifi y tampoco copia para restaurar — hace falta teclado y pantalla"
    return 1
  fi
  log "no hay perfil wifi: restaurando desde $BACKUP_DIR"
  ejecutar cp -p "$BACKUP_DIR"/*.nmconnection "$NM_DIR/"
  ejecutar chmod 600 "$NM_DIR"/*.nmconnection
  ejecutar nmcli connection reload
  local dev
  dev=$(interfaz_wifi)
  [ -n "$dev" ] && ejecutar nmcli device connect "$dev"
}

reboots_recientes() {
  local corte
  corte=$(( $(date +%s) - REBOOT_WINDOW_H * 3600 ))
  [ -f "$REBOOTS_FILE" ] || { echo 0; return; }
  awk -v c="$corte" '$1 >= c' "$REBOOTS_FILE" | wc -l | tr -d ' '
}

mkdir -p "$RUN_DIR" "$BACKUP_DIR"
chmod 700 "$STATE_DIR" "$BACKUP_DIR"

if [ "${1:-}" = "--respaldar" ]; then
  respaldar
  exit 0
fi

if hay_red; then
  if [ -s "$FALLOS_FILE" ] && [ "$(cat "$FALLOS_FILE")" != 0 ]; then
    log "red recuperada tras $(cat "$FALLOS_FILE") chequeo(s) sin red"
  fi
  echo 0 > "$FALLOS_FILE"
  respaldar
  exit 0
fi

fallos=$(( $(cat "$FALLOS_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$fallos" > "$FALLOS_FILE"
log "sin red ($fallos chequeo(s) seguidos)"

# Barato y es justo lo que pasó en el incidente: se intenta en cada fallo.
restaurar_perfil_si_falta

if [ "$fallos" -ge "$PASO_REBOOT" ]; then
  recientes=$(reboots_recientes)
  if [ "$recientes" -ge "$MAX_REBOOTS" ]; then
    log "ya hubo $recientes reboot(s) en las últimas ${REBOOT_WINDOW_H} h — no reinicio de nuevo"
    exit 0
  fi
  log "reiniciando la Pi (reboot $((recientes + 1)) de $MAX_REBOOTS en ${REBOOT_WINDOW_H} h)"
  date +%s >> "$REBOOTS_FILE"
  sync
  ejecutar systemctl reboot
elif [ "$fallos" -eq "$PASO_REINICIAR_NM" ]; then
  log "reiniciando NetworkManager"
  ejecutar systemctl restart NetworkManager
elif [ "$fallos" -eq "$PASO_RECONECTAR" ]; then
  dev=$(interfaz_wifi)
  if [ -n "$dev" ]; then
    log "reconectando $dev"
    ejecutar nmcli device disconnect "$dev"
    ejecutar nmcli device connect "$dev"
  fi
fi
exit 0
