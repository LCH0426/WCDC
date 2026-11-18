#!/usr/bin/env python3
"""Normalize a fnpack-produced .fpk.

The official fnpack build creates a gzip-compressed tar and writes an MD5
checksum of app.tgz into manifest. On Windows it may mark files as 0666.
This script keeps fnpack's structure/checksum contract, but rewrites app.tgz
with 0755 for the server binary and 0644 for other files, then rebuilds the
outer gzip tarball.

Usage:
    fnpack build
    python packaging/fnos/repack_fpk.py packaging/fnos/wcdc/wcdc.fpk
"""

from __future__ import annotations

import argparse
import hashlib
import io
import os
import tarfile
import time
from pathlib import Path


def build_app_tgz(old_app: bytes) -> bytes:
    with tarfile.open(fileobj=io.BytesIO(old_app), mode="r:gz") as old:
        contents = {
            member.name: old.extractfile(member).read()
            for member in old.getmembers()
            if member.isfile()
        }

    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz", format=tarfile.GNU_FORMAT) as archive:
        def add_dir(name: str) -> None:
            info = tarfile.TarInfo(name)
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            info.mtime = int(time.time())
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            archive.addfile(info)

        def add_file(name: str, data: bytes, mode: int) -> None:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = mode
            info.mtime = int(time.time())
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            archive.addfile(info, io.BytesIO(data))

        for directory in ("bin", "ui", "ui/images", "config"):
            add_dir(directory)
        for name, data in sorted(contents.items()):
            if name == "bin/.gitkeep":
                continue
            mode = 0o755 if name == "bin/wcdc-server" else 0o644
            add_file(name, data, mode)
    return output.getvalue()


def build_outer(entries: dict[str, bytes], app_tgz: bytes, manifest: bytes) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz", format=tarfile.GNU_FORMAT) as archive:
        def add_dir(name: str) -> None:
            info = tarfile.TarInfo(name)
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            info.mtime = int(time.time())
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            archive.addfile(info)

        def add_file(name: str, data: bytes, mode: int) -> None:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = mode
            info.mtime = int(time.time())
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            archive.addfile(info, io.BytesIO(data))

        add_file("app.tgz", app_tgz, 0o644)
        add_dir("cmd")
        for name, data in sorted(entries.items()):
            if name.startswith("cmd/"):
                add_file(name, data, 0o755)
        add_dir("config")
        for name, data in sorted(entries.items()):
            if name.startswith("config/"):
                add_file(name, data, 0o644)
        for name in ("ICON.PNG", "ICON_256.PNG"):
            add_file(name, entries[name], 0o644)
        add_file("manifest", manifest, 0o644)
        add_dir("wizard")
    return output.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser(description="Fix fnpack fpk modes and checksum")
    parser.add_argument("fpk", type=Path, help="fnpack-produced .fpk (rewritten in place)")
    args = parser.parse_args()

    with tarfile.open(args.fpk, "r:gz") as source:
        entries = {
            member.name: source.extractfile(member).read()
            for member in source.getmembers()
            if member.isfile()
        }
        app_tgz = entries.pop("app.tgz")
        manifest = entries.pop("manifest").decode("utf-8")

    new_app = build_app_tgz(app_tgz)
    checksum = hashlib.md5(new_app).hexdigest()
    lines = [line for line in manifest.splitlines() if not line.strip().startswith("checksum")]
    lines.append(f"{'checksum':<27}= {checksum}")
    new_manifest = ("\n".join(lines) + "\n").encode("utf-8")

    result = build_outer(entries, new_app, new_manifest)
    args.fpk.write_bytes(result)
    print(f"app.tgz md5: {checksum}")
    print(f"wrote {args.fpk} ({len(result)} bytes)")


if __name__ == "__main__":
    main()
