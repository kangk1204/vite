#!/usr/bin/env python3
"""Validate an attached crate with CRS4's validator and read its files with ro-crate-py."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys


def digest_file(filename):
    with filename.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def consume(crate_directory, required_roles):
    from rocrate.rocrate import ROCrate

    crate = ROCrate(crate_directory, version='1.1')
    file_rows = []
    for entity in crate.get_entities():
        expected = entity.get('sha256')
        if not expected:
            continue
        source = Path(entity.source)
        if not source.is_file():
            raise ValueError(f'Consumer cannot retrieve {entity.id}')
        actual = digest_file(source)
        if actual != expected or source.stat().st_size != int(entity.get('contentSize')):
            raise ValueError(f'Consumer digest/size mismatch for {entity.id}')
        file_rows.append({'id': entity.id, 'roles': str(entity.get('description', '')).split(', '), 'sha256': actual, 'sizeBytes': source.stat().st_size})
    roles = {role for row in file_rows for role in row['roles']}
    missing = set(required_roles) - roles
    if missing:
        raise ValueError(f'Required consumer roles unavailable: {sorted(missing)}')
    actions = [entity for entity in crate.get_entities() if entity.type == 'CreateAction']
    generated_ids = {entity.id for action in actions for entity in action.get('result', [])}
    consumed_ids = {entity.id for action in actions for entity in action.get('object', [])}
    for row in file_rows:
        if 'camera' in row['roles'] and (row['id'] not in generated_ids or row['id'] in consumed_ids):
            raise ValueError('CAMERA is not represented as a generated result')
    workflow = crate.root_dataset.get('mainEntity')
    return {'reader': 'rocrate', 'version': importlib.metadata.version('rocrate'),
            'workflow': workflow.id if workflow else None, 'files': file_rows,
            'generated': sorted(generated_ids), 'consumed': sorted(consumed_ids)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('crate', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--profile', default='workflow-run-crate-0.5')
    parser.add_argument('--require-role', action='append', default=[])
    parser.add_argument('--copy-to', type=Path)
    args = parser.parse_args()
    original = args.crate.resolve()
    directory = original
    if args.copy_to:
        directory = args.copy_to.resolve()
        if directory.exists():
            raise ValueError('Choose a fresh transfer directory')
        shutil.copytree(original, directory)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    validator = Path(sys.executable).with_name('rocrate-validator')
    report_path = args.output.with_suffix('.validator.json')
    command = [str(validator), '-y', '--disable-color', 'validate', str(directory),
               '-p', args.profile, '-l', 'required', '--packaging-mode', 'attached',
               '--enforce-availability', '--no-paging', '-f', 'json', '-o', str(report_path)]
    process = subprocess.run(command, capture_output=True, text=True)
    args.output.with_suffix('.validator.log').write_text(process.stdout + process.stderr)
    report = json.loads(report_path.read_text()) if report_path.exists() else {}
    if process.returncode or not report.get('passed') or report.get('skipped_checks'):
        raise ValueError(f'Official profile validation failed; inspect {report_path}')
    consumer = consume(directory, args.require_role)
    result = {'scope': 'Official required profile checks and independent artifact retrieval',
              'metadataSha256': digest_file(directory / 'ro-crate-metadata.json'),
              'copiedDirectory': bool(args.copy_to), 'validator': report['meta'],
              'command': command, 'profiles': report['statistics']['profiles'],
              'mandatoryChecks': report['statistics']['total_checks'],
              'mandatoryPassed': report['statistics']['total_passed_checks'],
              'skippedChecks': report['skipped_checks'], 'consumer': consumer}
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'passed': result['mandatoryPassed'], 'checks': result['mandatoryChecks'], 'filesRead': len(consumer['files']), 'receipt': str(args.output)}))


if __name__ == '__main__':
    main()
