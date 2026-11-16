"""Source-backed figure of the public delivery inspection examples."""
import argparse
import csv
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASE_ORDER = ('normal', 'contrast-conflict', 'changed-file', 'missing-file', 'consistent-labels')
LABELS = ('Original delivery', 'Conflicting contrast', 'Changed supplied file',
          'Required file missing', 'Coherently changed labels\n(record-only)')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def summarize_case(row):
    if row['observed'] not in {'normal', 'mismatch', 'unverifiable'} or row['observed'] != row['expectedTechnicalOutcome']:
        raise ValueError('Observed outcome contradicts the declared technical construction')
    record_only = 'record-only' in row['entryPoint']
    label_state = row.get('biologicalLabelAssessment', 'not_assessed')
    if row['id'] == 'consistent-labels' and (not record_only or label_state != 'unresolved'):
        raise ValueError('The label-consistency limit must remain record-only and unresolved')
    result = {'id': row['id'], 'scope': 'record-only' if record_only else 'inspector-and-report',
              'expected_technical_outcome': row['expectedTechnicalOutcome'], 'observed': row['observed'],
              'paired_raw_evidence_equal': row['fullBasicRawEqual'], 'biological_label_assessment': label_state}
    for category in ('artifact', 'claim'):
        checks = [c for c in row['checks'] if c['id'].startswith(category + ':')]
        states = {c['status'] for c in checks}
        if states - {'pass', 'fail', 'unknown'}:
            raise ValueError('Unknown check state')
        result[category + '_total'] = len(checks)
        for status in ('pass', 'fail', 'unknown'):
            result[category + '_' + status] = sum(c['status'] == status for c in checks)
        state = 'fail' if 'fail' in states else 'unknown' if 'unknown' in states else 'pass'
        result[category + '_state'] = state if checks else 'unavailable'
    return result


def category_text(row, category):
    total = row[category + '_total']
    if not total:
        return 'Not requested'
    lines = [f"{row[category + '_pass']}/{total} match"]
    for state, label in [('fail', 'conflict'), ('unknown', 'unavailable')]:
        if row[category + '_' + state]:
            lines.append(f"{row[category + '_' + state]} {label}")
    return '\n'.join(lines)


def draw(rows, output):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.patches import Rectangle
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'svg.fonttype': 'none', 'pdf.fonttype': 42})
    fig, ax = plt.subplots(figsize=(7.2, 3.1))
    fig.subplots_adjust(left=.025, right=.99, top=.96, bottom=.16)
    ax.set(xlim=(0, 9.4), ylim=(.8, 6.1))
    ax.axis('off')
    widths = [3.05, 1.55, 1.55, 1.55, 1.65]
    positions = [0]
    for width in widths:
        positions.append(positions[-1] + width)
    headers = ('Supplied example', 'File bytes', 'Analysis fields', 'Technical result', 'Product report')
    colors = {'pass': '#e7f0ec', 'fail': '#f6e8e6', 'unknown': '#f8efdc', 'unavailable': '#f0f2f4'}
    outcome_states = {'normal': 'pass', 'mismatch': 'fail', 'unverifiable': 'unknown'}
    outcomes = {'normal': 'Consistent', 'mismatch': 'Conflict', 'unverifiable': 'Unverifiable'}
    for index, header in enumerate(headers):
        ax.text(positions[index] + .08, 5.83, header, fontsize=9, fontweight='bold', va='center', color='#203b49')
    for index, row in enumerate(rows):
        y = 4.85 - index * .94
        texts = (LABELS[index], category_text(row, 'artifact'), category_text(row, 'claim'),
                 outcomes[row['observed']], 'Record-only\ninspection' if row['scope'] == 'record-only' else 'Full/basic\nraw data equal')
        fills = ('#fff', colors[row['artifact_state']], colors[row['claim_state']],
                 colors[outcome_states[row['observed']]], '#f0f2f4')
        for column, (text, fill) in enumerate(zip(texts, fills)):
            ax.add_patch(Rectangle((positions[column], y), widths[column] - .06, .82, facecolor=fill, edgecolor='none'))
            ax.text(positions[column] + .08, y + .41, text, fontsize=9, va='center', color='#20333e')
    fig.text(.03, .09, 'Coherent labels can pass consistency checks while biological label truth remains unresolved.', fontsize=7.7)
    fig.text(.03, .045, 'Constructed paired-airway deliveries. External adjudication and user outcomes are prospective.', fontsize=7.2, color='#526570')
    for extension in ('png', 'pdf', 'svg'):
        fig.savefig(str(output) + '.' + extension, dpi=360, facecolor='white')
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--validation', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    source = args.validation.resolve()
    original_hash = digest(source)
    receipt = json.loads(source.read_text())
    if receipt.get('scope') != 'developer-defined delivery contract checks' or receipt.get('humanRatings') != 0:
        raise ValueError('This figure requires the developer-defined technical record')
    cases = {c['id']: c for c in receipt['cases']}
    if len(cases) != len(receipt['cases']) or set(cases) != set(CASE_ORDER):
        raise ValueError('The five declared examples must occur exactly once')
    rows = [summarize_case(cases[key]) for key in CASE_ORDER]
    if not all(row['paired_raw_evidence_equal'] is True for row in rows if row['scope'] != 'record-only'):
        raise ValueError('Full/basic report evidence differs')
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with Path(str(output) + '.source.tsv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]), delimiter='\t')
        writer.writeheader()
        writer.writerows(rows)
    draw(rows, output)
    legend = ('Figure 3. Observed responses to five constructed paired-airway delivery examples. '
              'File and requested-analysis-field checks use the public inspector. Four examples also use the '
              'normal report CLI, producing full and basic reports with identical raw evidence. The coherent-label '
              'example uses record-only inspection and illustrates unresolved biological naming despite technical '
              'consistency. These examples describe defined software behavior. Human adjudication and interpretation '
              'outcomes are prospective. Colors indicate matching, conflicting and unavailable checks.\n')
    Path(str(output) + '.legend.txt').write_text(legend)
    from study.build_implementation_figures import write_source_xlsx, write_legend_docx
    write_source_xlsx(Path(str(output) + '.source.xlsx'), rows)
    write_legend_docx(Path(str(output) + '.legend.docx'), 'Figure 2 Delivery inspection', legend)
    suffixes = ('png', 'pdf', 'svg', 'source.tsv', 'source.xlsx', 'legend.txt', 'legend.docx')
    outputs = [Path(str(output) + '.' + suffix) for suffix in suffixes]
    if digest(source) != original_hash:
        raise ValueError('The source receipt changed during rendering')
    manifest = {'figure': output.name, 'scope': receipt['scope'], 'humanRatings': 0,
                'inputs': [{'path': str(source.relative_to(ROOT)), 'sha256': original_hash},
                           {'path': str(Path(__file__).relative_to(ROOT)), 'sha256': digest(Path(__file__))},
                           {'path': 'scripts/study/build_implementation_figures.py', 'sha256': digest(ROOT/'scripts/study/build_implementation_figures.py')}],
                'source': receipt['source'],
                'outputs': [{'path': p.name, 'sha256': digest(p), 'bytes': p.stat().st_size} for p in outputs]}
    Path(str(output) + '.manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'figure': output.name, 'cases': len(rows), 'sourceSha256': original_hash}))


if __name__ == '__main__':
    main()
