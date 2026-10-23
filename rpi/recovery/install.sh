#!/bin/bash
# Instala la autorrecuperación de la Pi. Idempotente: se puede correr de
# nuevo después de cada `git pull` que toque rpi/recovery/.
#
#   cd ~/expense-tracker/rpi/recovery && sudo bash install.sh
#
# Qué instala:
#   - (El watchdog de hardware NO se instala acá: Raspberry Pi OS ya lo activa con
#     /usr/lib/systemd/system.conf.d/40-rpi-enable-watchdog.conf, a 1 minuto.)
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

echo "== Limpieza de la versión anterior del watchdog de hardware"
# Una versión previa de este instalador copiaba 10-watchdog.conf. Nunca tuvo
# efecto: el sistema trae 40-rpi-enable-watchdog.conf, que ordena después y gana.
rm -f /etc/systemd/system.conf.d/10-watchdog.conf

echo "== Wifi sin ahorro de energía"
install -m 644 "$DIR/wifi-powersave-off.conf" /etc/NetworkManager/conf.d/

echo "== Respaldo inicial del perfil wifi"
/usr/local/sbin/net-watchdog --respaldar
ls -1 /var/lib/net-watchdog/wifi/ | sed 's/^/   /'

echo "== Activando"
systemctl daemon-reload
systemctl enable --now net-watchdog.timer
# El servicio solo se reinicia para que tome StartLimit/OnFailure nuevos.
systemctl restart expense-tracker

echo
echo "Listo. Verificar:"
echo "  systemctl show -p RuntimeWatchdogUSec          # 1min: lo fija Raspberry Pi OS"
echo "  systemctl list-timers net-watchdog.timer"
echo "  journalctl -u net-watchdog -n 20"
echo
echo "Falta un reboot para que tome el wifi sin ahorro de energía:"
echo "  sudo reboot"
