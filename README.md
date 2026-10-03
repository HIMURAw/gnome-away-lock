# Away Lock

A GNOME Shell extension that locks the screen when you walk away from the computer,
like Windows Hello's "lock when you're away".

## How it works

- While you type or move the mouse, the camera stays off.
- After a while without input (30 seconds by default) it takes a quick look through the
  camera every 10 seconds. An IR camera sees in the dark too.
- When nobody is there for two looks in a row, the screen locks. If you are there, it
  keeps looking until you touch the computer again.
- It does not look while something keeps the session awake on purpose: a video playing,
  or Caffeine.
- If the camera is busy (a video call), that look counts as "you are there".
- Frames are only looked at in memory and never saved. Detection runs locally with dlib.

With [Howdy](https://github.com/boltgolt/howdy) set up, the screen then unlocks with your
face as soon as you come back and press a key.

## Settings

The **Away Lock** toggle sits in Quick Settings (in the island, with Dynamic Island).
Its menu sets how long to wait before looking, and has a camera test.

```
gsettings --schemadir schemas set org.gnome.shell.extensions.away-lock absent-checks 3
gsettings --schemadir schemas set org.gnome.shell.extensions.away-lock camera /dev/video2
```

The camera defaults to Howdy's `device_path`, otherwise `/dev/video0`.

## Requirements

- GNOME Shell 50
- `python3` with OpenCV (`cv2`) and `dlib`. Howdy installs both.

## Install

```
git clone https://github.com/HIMURAw/gnome-away-lock
cd gnome-away-lock && ./install.sh
```

Log out and back in once.

## Development

- `./detect.py /dev/video2` prints `present`, `absent`, `busy` or `missing`.
- `./build.sh pot` refreshes translations, `./build.sh pack` builds the zip.
- `npm install && npx eslint .` lints the code.
