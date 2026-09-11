#!/bin/bash
set -euo pipefail

byte_repository__bytes=(
    45 32 67 111 110 115 101 110 116 10 45 32 66 114 111 119
    110 32 118 32 75 101 110 100 97 108 108 10
)

glyph_assembly_strategy__assemble() {
    local -a bytes=("$@")
    local byte
    local escaped=""
    local assembled
    for byte in "${bytes[@]}"; do
        escaped+="\\$(printf '%03o' "$byte")"
    done
    printf -v assembled '%b' "$escaped"
    printf '%s' "$assembled"
}

document_assembly_engine__render() {
    glyph_assembly_strategy__assemble "${byte_repository__bytes[@]}"
}

console_output_sink__write_line() {
    printf '%s\n' "$1"
}

document_compiler_facade__execute() {
    local rendered
    rendered="$(document_assembly_engine__render)"
    console_output_sink__write_line "$rendered"
}

document_compiler_facade__execute
