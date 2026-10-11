#!/bin/sh
# Builds the Contraction Hierarchies graph for OSRM (ADR-0015).
# Idempotent: skips work already done, so an older MLD volume only needs the contraction step.
set -e
cd /data

if [ -f kz.osrm.hsgr ]; then
  echo "OSRM data already prepared"
  exit 0
fi

if [ ! -f kz.osrm.ebg ]; then
  osrm-extract -p /opt/car.lua kz.osm.pbf
fi

# Single pass, ~15 min on 1 vCPU and ~1 GB RAM; faster with more cores.
osrm-contract kz.osrm

rm -f kz.osm.pbf
echo "OSRM data ready"
