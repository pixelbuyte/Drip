#!/usr/bin/env python3
"""Fail if any DripKit source imports a package module its target does not
(transitively) depend on.

Linux CI cannot compile the SwiftUI files (they are gated on UIKit), so an
undeclared module import in a view only surfaces on an iOS build. This check
catches that class of error everywhere, from Package.swift itself.

Usage: check-imports.py <path to DripKit>
"""
import json, re, subprocess, sys
from pathlib import Path

pkg = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
dump = json.loads(subprocess.check_output(['swift', 'package', 'dump-package'], cwd=pkg))

targets = {t['name']: t for t in dump['targets']}
direct = {}
for name, t in targets.items():
    deps = set()
    for d in t.get('dependencies', []):
        for kind in ('byName', 'target', 'product'):
            if kind in d:
                deps.add(d[kind][0])
    direct[name] = deps

def closure(name, seen=None):
    seen = set() if seen is None else seen
    for d in direct.get(name, ()):
        if d not in seen:
            seen.add(d)
            closure(d, seen)
    return seen

errors = []
for name, t in targets.items():
    root = pkg / (t.get('path') or (('Tests/' if t['type'] == 'test' else 'Sources/') + name))
    allowed = closure(name) | {name}
    for f in root.rglob('*.swift'):
        for i, line in enumerate(f.read_text().splitlines(), 1):
            m = re.match(r'\s*(?:@testable\s+)?import\s+(\w+)', line)
            if m and m.group(1) in targets and m.group(1) not in allowed:
                errors.append(f'{f.relative_to(pkg)}:{i}: {name} imports {m.group(1)} without depending on it')

print('\n'.join(errors) if errors else f'imports OK across {len(targets)} targets')
sys.exit(1 if errors else 0)
