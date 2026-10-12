#!/bin/sh
# Build es.wasm (engine-sim core + engine_builder + C API) with wasi-sdk 24.
# Usage: SDK=/path/to/wasi-sdk-24.0 ./build_wasm.sh   then   node web/build.js
set -e
cd "$(dirname "$0")"
SDK=${SDK:?set SDK to your wasi-sdk-24 folder}
CXX="$SDK/bin/clang++ --target=wasm32-wasip1 --sysroot=$SDK/share/wasi-sysroot -std=c++17 -O3 -ffast-math -fno-exceptions -DNDEBUG -DESWEB_NO_THREADS -D__forceinline=inline -Iengine-sim/include -w -msimd128"
mkdir -p objw
SRCS=$( (ls engine-sim/src/*.cpp; find engine-sim -path '*simple-2d-constraint-solver/src/*.cpp') | grep -vE '_object|_cluster|gauge|engine_sim_application|engine_view|firing_order_display|geometry_generator|/main.cpp|oscilloscope|shaders|simulation_object|throttle_display|ui_|audio_buffer|load_simulation')
for f in $SRCS port/engine_builder.cpp port/es_api.cpp; do
  o=objw/$(echo $f | tr / _).o
  if [ ! -f $o ] || [ $f -nt $o ] || [ port/engine_builder.h -nt $o ]; then $CXX -c $f -o $o; fi
done
EXPORTS=$(grep -o 'API [a-z *]*\(es_[a-z_0-9]*\)' port/es_api.cpp | grep -o 'es_[a-z_0-9]*' | sed 's/^/-Wl,--export=/' | tr '\n' ' ')
$CXX -mexec-model=reactor $EXPORTS -Wl,--export=_initialize -Wl,--strip-all -Wl,-z,stack-size=1048576 -Wl,--initial-memory=33554432 -Wl,--max-memory=268435456 objw/*.o -o es.wasm
ls -la es.wasm
