#!/usr/bin/env python3
"""Is someone in front of the camera? Prints one word and exits:

present  a face was seen            (exit 0)
absent   frames came, no face        (exit 1)
busy     the camera could not open   (exit 2), e.g. a video call has it
missing  OpenCV or dlib not installed (exit 3)

Frames are only looked at in memory, never saved. Usage: detect.py /dev/videoN
"""
import sys

try:
    import cv2
    import dlib
except ImportError:
    print("missing")
    sys.exit(3)

FRAMES = 8   # IR cameras alternate lit and dark frames; 8 covers a few lit ones
DARK = 5     # mean brightness below this is an unlit frame (lit but empty rooms read ~13)


def main():
    cap = cv2.VideoCapture(sys.argv[1] if len(sys.argv) > 1 else "/dev/video0", cv2.CAP_V4L2)
    if not cap.isOpened():
        print("busy")
        return 2
    detector = dlib.get_frontal_face_detector()
    try:
        for _ in range(FRAMES):
            ok, frame = cap.read()
            if not ok:
                continue
            gray = frame if frame.ndim == 2 else cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if gray.mean() < DARK:
                continue
            if len(detector(gray, 1)) > 0:
                print("present")
                return 0
    finally:
        cap.release()
    print("absent")
    return 1


sys.exit(main())
