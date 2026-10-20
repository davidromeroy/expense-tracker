#!/bin/bash
# Instala la autorrecuperación de la Pi. Idempotente: se puede correr de
# nuevo después de cada `git pull` que toque rpi/recovery/.
#
#   cd ~/expense-tracker/rpi/recovery && sudo bash install.sh
#
# Qué instala:
#   - Watchdog de hardware: el chip reinicia la Pi si el kernel se cuelga.
#   - net-watchdog (timer cada 2 min): respalda el perfil wifi, lo restaura
#     si desaparece, y escala reconectar → reiniciar NetworkManager → reboot.
#   - expense-tracker-repair: npm ci automático si el servicio entra en bucle
#     de reinicios.
#   - Ahorro de energía del wifi desactivado.
#
# Los scripts se copian a /usr/local/sbin en vez de correrlos desde el repo:
# el watchdog de red no puede depender de que el repo esté sano (en el
# incidente lo que se corrompió fue justamente un archivo del repo).

set -euo pipefail

if [ "$(id -u)" != 0 ]; then
  echo "Correr con sudo: sudo bash install.sh" >&2
  exit 1
fi

DIR=$(cd "$(dirname "$0")" && pwd)
RPI_DIR=$(dirname "$DIR")

echo "== Scripts"
install -m 755 "$DIR/net-watchdog.sh" /usr/local/sbin/net-watchdog
install -m 755 "$DIR/repair-node-modules.sh" /usr/local/sbin/expense-tracker-repair

echo "== Units de systemd"
install -m 644 "$DIR/net-watchdog.service" /etc/systemd/system/
install -m 644 "$DIR/net-watchdog.timer" /etc/systemd/system/
install -m 644 "$DIR/expense-tracker-repair.service" /etc/systemd/system/
install -m 644 "$RPI_DIR/expense-tracker.service" /etc/systemd/system/

echo "== Watchdog de hardware"
install -d /etc/systemd/system.conf.d
install -m 644 "$DIR/watchdog.conf" /etc/systemd/system.conf.d/10-watchdog.conf
CONFIG=/boot/firmware/config.txt
[ -f "$CONFIG" ] || CONFIG=/boot/config.txt
if grep -q '^dtparam=watchdog=on' "$CONFIG"; then
  echo "   dtparam=watchdog=on ya estaba en $CONFIG"
else
  cp -p "$CONFIG" "$CONFIG.bak-$(date +%Y%m%d)"
  printf '\n# Watchdog de hardware (expense-tracker/rpi/recovery)\ndtparam=watchdog=on\n' >> "$CONFIG"
  echo "   agregado dtparam=watchdog=on a $CONFIG (copia en $CONFIG.bak-*)"
fi

echo "== Wifi sin ahorro de energía"
install -m 644 "$DIR/wifi-powersave-off.conf" /etc/NetworkManager/conf.d/

echo "== Respaldo inicial del perfil wifi"
/usr/local/sbin/net-watchdog --respaldar
ls -1 /var/lib/net-watchdog/wifi/ | sed 's/^/   /'

echo "== Activando"
systemctl daemon-reload
# Aplica 10-watchdog.conf sin reiniciar (re-ejecuta systemd, no corta SSH).
systemctl daemon-reexec
systemctl enable --now net-watchdog.timer
# El servicio solo se reinicia para que tome StartLimit/OnFailure nuevos.
systemctl restart expense-tracker

echo
echo "Listo. Verificar:"
echo "  systemctl show -p RuntimeWatchdogUSec          # debería decir 14s"
echo "  systemctl list-timers net-watchdog.timer"
echo "  journalctl -u net-watchdog -n 20"
echo
echo "Falta un reboot para que tomen dtparam=watchdog=on y el wifi sin ahorro:"
echo "  sudo reboot"
