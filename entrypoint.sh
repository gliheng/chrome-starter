#! /bin/sh

if [ ! -d /var/run/dbus ]; then
    mkdir -p /var/run/dbus
fi

/usr/bin/dbus-daemon --system

node index.mjs