#!/bin/bash
cd "/home/patryk/Desktop/New Folder/Minecraft-Rally"
mkdir -p shots
python3 -m http.server 8000 >/tmp/srv.log 2>&1 &
SRV=$!
sleep 1.2
CH=/usr/bin/google-chrome
run() { # name url
  $CH --headless=new --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
      --enable-webgl --enable-logging=stderr --v=0 --window-size=1280,720 \
      --virtual-time-budget=9000 --screenshot=shots/$1.png "$2" 2>>/tmp/chrome.log
  echo "$1 -> $(ls -la shots/$1.png 2>/dev/null | awk '{print $5}') bytes"
}
B=http://localhost:8000/index.html
run hud_full_1500 "$B?frames=1500&shot=1"
run hud_full_2600 "$B?frames=2600&shot=1"
run hud_full_4200 "$B?frames=4200&shot=1"
run hud_min_1500 "$B?frames=1500&hud=min&shot=1"
run hud_off_1500 "$B?frames=1500&hud=off&shot=1"
run hud_dnf_600 "$B?frames=600&ref=1&shot=1"
kill $SRV 2>/dev/null
echo "--- chrome console errors ---"
grep -iE "uncaught|error|CONSOLE" /tmp/chrome.log | grep -v "swiftshader\|Fallback\|dbus\|GPU\|gl_" | head -20
echo "(end)"
