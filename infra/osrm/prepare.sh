#!/bin/sh
set -e
cd /data
if [ -f kz.osrm.mldgr ]; then
  echo "OSRM data already prepared"
  exit 0
fi
osrm-extract -p /opt/car.lua kz.osm.pbf
osrm-partition kz.osrm
osrm-customize kz.osrm
rm -f kz.osm.pbf
echo "OSRM data ready"
