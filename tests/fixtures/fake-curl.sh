#!/bin/sh
# Stand-in for curl in benchmark preparation tests: writes bytes that differ
# from every pinned upstream payload to the -o destination.
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    http*) url=$1 ;;
  esac
  shift
done
printf 'changed upstream payload from %s\n' "$url" > "$out"
