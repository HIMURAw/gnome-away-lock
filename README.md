# Away Lock

A GNOME Shell extension that locks the screen when you walk away from the computer, like Windows Hello's "lock when you're away". It uses your camera to tell whether someone is sitting there, and works with [Howdy](https://github.com/boltgolt/howdy) face unlock if you have it.

<!-- screenshot: GNOME Quick Settings panel open with the "Away Lock" toggle switched on and its menu expanded: the "Start looking after" list (15 s, 30 s with a check mark, 1 min, 2 min), "Test the camera now" and a status line such as "Saw you at 14:32" -->

Part of [himura-desktop](https://github.com/HIMURAw/himura-desktop), but it works on its own.

## How it works

1. While you type or move the mouse, the camera stays off.
2. After a while without input (30 seconds by default), it takes a quick look through the camera every 10 seconds.
3. A look is a short burst of frames analysed on your machine with dlib's face detector. An IR camera works in the dark; unlit IR frames are skipped.
4. When nobody is there for two looks in a row, the screen locks. If you are there, it keeps looking until you touch the computer again.
5. If the camera cannot be opened (for example it is busy in a video call), that look counts as "you are there".
6. It does not look while something keeps the session awake on purpose, such as a video playing or Caffeine.

**Before sleep.** If GNOME is set to suspend when idle, Away Lock also looks about 20 seconds before the suspend would happen. If you are there (reading, watching), it holds the suspend off and checks again every minute. If nobody is there on two looks 5 seconds apart, it suspends right away, and GNOME locks the screen on suspend as usual. If the camera is busy, the computer stays awake rather than sleep under you.

**Unlocking.** Away Lock only locks. With Howdy set up, the lock screen unlocks with your face when you come back and press a key.

## Privacy

Nothing leaves your computer. Each look runs `detect.py`, which reads a few frames from the camera into memory, runs the face detector locally and prints one word (`present`, `absent`, `busy` or `missing`). Frames are never written to disk, and there is no network code in the extension or the detector. The camera is only used while the computer is idle and only until you move the mouse or press a key.

## Requirements

- GNOME Shell 50 (the only version listed in `metadata.json`)
- `python3` with OpenCV (`cv2`) and `dlib`. Howdy installs both and is the easiest way to get them.
- A camera. An IR camera is best; any webcam that `cv2` can open works in a lit room.
- `glib-compile-schemas` and `msgfmt` (gettext) when you install from source

Check the Python side with:

```bash
python3 -c "import cv2, dlib; print('ok')"
```

Without Howdy you can try `pip install --user opencv-python dlib`, but dlib is built from source and needs cmake and a C++ compiler.

## Install

After installing on Wayland, **log out and back in** once. GNOME only loads new extensions at login.

### 1. With the himura-desktop installer

```bash
curl -fsSL https://raw.githubusercontent.com/HIMURAw/himura-desktop/main/install.sh | bash -s -- away-lock
```

### 2. From source

| Distro | Command |
| --- | --- |
| Fedora | `sudo dnf install git gettext glib2` |
| Ubuntu / Debian | `sudo apt install git gettext libglib2.0-bin` |
| Arch | `sudo pacman -S git gettext glib2` |

Then install Howdy (or OpenCV and dlib) as described above, and:

```bash
git clone https://github.com/HIMURAw/gnome-away-lock
cd gnome-away-lock
./install.sh
```

`install.sh` compiles the schema and translations, links the folder into `~/.local/share/gnome-shell/extensions/away-lock@himuraw` and enables it. Update with `git pull`.

### Uninstall

```bash
gnome-extensions disable away-lock@himuraw
rm ~/.local/share/gnome-shell/extensions/away-lock@himuraw
```

If you used the himura-desktop installer, this does the same:

```bash
curl -fsSL https://raw.githubusercontent.com/HIMURAw/himura-desktop/main/uninstall.sh | bash -s -- away-lock
```

## Settings

The **Away Lock** toggle is in Quick Settings (in the Dynamic Island, if you use it). Its menu has:

- **Start looking after**: 15 s, 30 s, 1 min or 2 min of no input
- **Test the camera now**: takes one look and shows the result as a notification
- a status line with the result of the last look (saw you, nobody there, camera busy)

Everything else is in `gsettings`:

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Lock the screen when nobody is in front of the camera (the Quick Settings toggle) |
| `idle-seconds` | integer, 10 to 600 | `30` | Seconds without input before the camera starts looking |
| `absent-checks` | integer, 1 to 10 | `2` | Looks in a row without a face before locking (one look every 10 seconds) |
| `camera` | string | `''` | Camera device, such as `/dev/video2`. Empty uses Howdy's `device_path`, or `/dev/video0` |
| `away-command` | string | `''` | Shell command run instead of locking when nobody is there. Exit code 0 within 5 seconds means it takes over and will lock the screen itself; anything else, or no answer in time, and the screen locks right away |

```bash
SCHEMA=~/.local/share/gnome-shell/extensions/away-lock@himuraw/schemas

gsettings --schemadir $SCHEMA set org.gnome.shell.extensions.away-lock idle-seconds 60
gsettings --schemadir $SCHEMA set org.gnome.shell.extensions.away-lock absent-checks 3
gsettings --schemadir $SCHEMA set org.gnome.shell.extensions.away-lock camera /dev/video2
gsettings --schemadir $SCHEMA reset org.gnome.shell.extensions.away-lock camera
```

To find the right camera, run `v4l2-ctl --list-devices` (package `v4l-utils`), then try `./detect.py /dev/videoN` from the extension folder. Howdy users already have the IR camera in `device_path` in Howdy's `config.ini`, which Away Lock reads from `/usr/local/etc/howdy`, `/etc/howdy`, `/usr/lib64/security/howdy` or `/lib/security/howdy`.

## Colour themes

Away Lock has no colours of its own: it only adds a standard Quick Settings toggle, so it simply follows whatever theme your shell uses, including the Mor theme from [himura-desktop](https://github.com/HIMURAw/himura-desktop) and its `tema-rengi` colours. There is nothing to configure.

## Troubleshooting

**The toggle is not in Quick Settings.** Log out and back in after installing, then check `gnome-extensions list --enabled | grep away-lock`.

**"Needs python3-opencv and dlib" shows in the menu.** `python3` cannot import `cv2` or `dlib`. Run the check command above, and install Howdy or the two modules.

**It never locks.** Use "Test the camera now". `Camera busy` means the device could not be opened: wrong `camera` value, or another app holds it (a busy camera always counts as "you are there"). Also remember it does not look while a video plays or Caffeine is on, or while you are active.

**It locks while I am sitting there.** Raise `absent-checks`, or point `camera` at a camera that sees your face. In a dark room use an IR camera; an ordinary webcam sees nothing in the dark.

**Which camera is it using?** `camera` if set, otherwise Howdy's `device_path`, otherwise `/dev/video0`.

**Logs.**

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Translations

The menu is translated through gettext. Turkish is included (`po/tr.po`). To add a language, copy `po/away-lock@himuraw.pot` to `po/<lang>.po`, translate it, and run `./build.sh locale`. `./build.sh pot` refreshes the template and merges it into the existing `.po` files after you change strings.

## Contributing

Issues and pull requests are welcome.

- `./detect.py /dev/video2` prints `present`, `absent`, `busy` or `missing` (exit codes 0, 1, 2, 3).
- `./build.sh locale` compiles schemas and translations, `./build.sh pot` refreshes the template, `./build.sh pack` builds the zip for extensions.gnome.org and GitHub releases.
- `npm install && npx eslint .` lints the code.

## License

GPL-3.0. See [LICENSE](LICENSE).
