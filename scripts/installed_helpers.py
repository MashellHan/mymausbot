import hashlib
import os
import re
import stat
from pathlib import Path


SOURCE_NAME = re.compile(r'^[a-z][a-z0-9_-]*\.py$')
CACHE_NAME = re.compile(r'^([a-z][a-z0-9_-]*)\.cpython-[0-9]+(?:\.opt-[12])?\.pyc$')


def _entry(path, directory=False):
    value = path.lstat()
    assert not stat.S_ISLNK(value.st_mode) and value.st_uid == os.getuid()
    assert (value.st_mode & 0o022) == 0
    assert stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode) and value.st_nlink == 1
    return value


def _sha(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def _sources(expected):
    assert isinstance(expected, dict) and expected
    assert all(SOURCE_NAME.fullmatch(name) and re.fullmatch(r'[a-f0-9]{64}', digest)
               for name, digest in expected.items())
    return set(expected)


def require_installed_helpers(directory, expected):
    root = Path(directory)
    assert root.is_absolute() and root.resolve() == root
    _entry(root, directory=True)
    names = _sources(expected)
    entries = {item.name: item for item in root.iterdir()}
    assert set(entries) in (names, names | {'__pycache__'})
    for name in names:
        _entry(entries[name])
        assert _sha(entries[name]) == expected[name]
    if '__pycache__' in entries:
        cache = entries['__pycache__']
        _entry(cache, directory=True)
        modules = {name[:-3] for name in names}
        for item in cache.iterdir():
            match = CACHE_NAME.fullmatch(item.name)
            assert match and match.group(1) in modules
            info = _entry(item)
            assert 16 <= info.st_size <= 16 * 1024 * 1024
    return names


def require_signed_helpers(directory, expected):
    root = Path(directory)
    assert root.is_absolute() and root.resolve() == root
    info = _entry(root, directory=True)
    assert stat.S_IMODE(info.st_mode) == 0o555
    names = _sources(expected)
    entries = {item.name: item for item in root.iterdir()}
    assert set(entries) == names
    for name in names:
        _entry(entries[name])
        assert _sha(entries[name]) == expected[name]
    return names


if __name__ == "__main__":
    import json
    import sys

    check, directory, hashes = sys.argv[1:]
    checks = {"installed-helpers": require_installed_helpers, "signed-helpers": require_signed_helpers}
    checks[check](directory, json.loads(Path(hashes).read_text()))
