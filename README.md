# Telegram Focus Blur

A GNOME Shell extension that keeps Telegram blurred until you hover over it.

- Move the pointer onto a Telegram window and it turns clear right away, using an Apple-style ease-out curve.
- Move the pointer away and Telegram stays clear for a short moment, then fades back into a frosted blur.
- Handy in open offices, on screen shares, or anywhere people can glance at your screen.

It does not modify Telegram. The extension puts a blurred overlay on top of Telegram's window inside GNOME Shell.

## Requirements

- GNOME Shell 48 (Wayland or X11)
- Any Telegram Desktop build: official tarball, Flatpak, Snap or distro package. Forks such as 64Gram or Kotatogram also work if their window class contains `telegram`.

## Install

```bash
git clone https://github.com/lan2k3/telegram-focus-blur.git
cd telegram-focus-blur
./install.sh
```

Then **log out and log back in**, because Wayland can't reload GNOME Shell in place. Enable the extension:

```bash
gnome-extensions enable telegram-focus-blur@lan2k3.github.io
```

Uninstall:

```bash
gnome-extensions uninstall telegram-focus-blur@lan2k3.github.io
```

## How it works

1. Telegram windows are detected by their WM class or app id, matching anything that contains `telegram`.
2. Every 40 ms the extension reads the pointer position and finds the topmost window under it.
3. Each Telegram window gets its own overlay, sized to the window frame (shadows excluded). The overlay blurs what is behind it with `Shell.BlurEffect` in background mode. It sits directly above Telegram, below any window covering it, and lets clicks pass through.
4. Blur radius and brightness are animated per frame with a `Clutter.Timeline`. If you move the pointer back mid-animation, the animation reverses from where it is, without jumping.

## Configuration

Edit the constants at the top of `extension.js`, then log out and back in:

| Constant        | Default | Meaning                                                  |
| --------------- | ------- | -------------------------------------------------------- |
| `BLUR_RADIUS`   | `40`    | Maximum blur radius                                      |
| `BRIGHTNESS`    | `0.85`  | Brightness when blurred (`1` = unchanged, lower = darker) |
| `REVEAL_MS`     | `380`   | How long it takes to turn clear on hover                 |
| `HIDE_DELAY_MS` | `1200`  | How long it stays clear after the pointer leaves         |
| `HIDE_MS`       | `900`   | How long it takes to blur again                          |
| `POLL_MS`       | `40`    | Pointer polling interval                                 |

## Known limitations

- Window thumbnails in the Activities overview and the Alt+Tab switcher are not blurred.
- Desktop notifications still show message previews. To hide them, open Telegram → Settings → Notifications and turn off sender name and message preview.
- Telegram stays blurred while you type if the pointer is outside its window.

## License

[GPL-2.0-or-later](LICENSE)
