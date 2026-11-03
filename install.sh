#!/usr/bin/env bash
# Installs the extension for the current user.
set -euo pipefail
cd "$(dirname "$0")"
UUID="telegram-focus-blur@lan2k3.github.io"
gnome-extensions pack --force --extra-source=LICENSE --out-dir=/tmp .
gnome-extensions install --force "/tmp/${UUID}.shell-extension.zip"
rm -f "/tmp/${UUID}.shell-extension.zip"
echo "Installed. Log out and back in (Wayland), then run:"
echo "  gnome-extensions enable ${UUID}"
