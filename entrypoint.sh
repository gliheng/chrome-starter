#! /bin/sh

if [ ! -d /var/run/dbus ]; then
    mkdir -p /var/run/dbus
fi

/usr/bin/dbus-daemon --system


export DBUS_SESSION_BUS_ADDRESS='unix:path=/var/run/dbus/system_bus_socket'

node index.mjs