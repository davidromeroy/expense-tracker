#!/bin/bash
# setup-swap.sh — habilita 512MB de swap en la Pi Zero 2W como colchón de
# seguridad. Con 512MB de RAM, Node + better-sqlite3 + googleapis cargados
# a la vez normalmente no se acercan al límite, pero el swap evita que un
# pico puntual (por ejemplo, muchas filas en un solo sync) tumbe el proceso
# con un OOM kill en vez de simplemente ir más lento.
set -e

sudo apt-get update
sudo apt-get install -y dphys-swapfile

sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=512/' /etc/dphys-swapfile
sudo systemctl restart dphys-swapfile

echo "Swap configurado. Verifica con: free -h"
