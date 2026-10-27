"""Load the dashboard catalog and validate service-owned YAML sources."""
import argparse
import json
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[2]

class UniqueKeys(yaml.SafeLoader):
    pass

def mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ValueError(f'Duplicate YAML key: {key}')
        result[key] = loader.construct_object(value_node, deep=deep)
    return result

UniqueKeys.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)

def load_dashboards(root=ROOT):
    catalog = yaml.load((root / 'infra/observability/defaults.yaml').read_text(), Loader=UniqueKeys)['dashboards']
    result = {}; uids = set()
    for name, entry in catalog.items():
        path = root / entry['source']
        if not path.resolve().is_relative_to(root.resolve()) or path.suffix != '.yaml':
            raise ValueError(f'Invalid dashboard path: {name}')
        dashboard = yaml.load(path.read_text(), Loader=UniqueKeys)
        uid = dashboard['uid']
        if uid in uids:
            raise ValueError(f'Duplicate dashboard UID: {uid}')
        uids.add(uid)
        if entry['folder'] == 'services':
            if entry['source'] != f'services/{name}/deploy/metrics/dashboard.yaml' or dashboard['title'] != name:
                raise ValueError(f'Service dashboard must be owned and titled by {name}')
        elif entry['folder'] != 'infrastructure':
            raise ValueError(f'Unknown dashboard folder: {name}')
        if not dashboard['panels']:
            raise ValueError(f'Empty dashboard: {name}')
        ids = [p['id'] for p in dashboard['panels']]
        if len(ids) != len(set(ids)):
            raise ValueError(f'Duplicate panel IDs: {name}')
        json.dumps(dashboard, allow_nan=False)
        result[name] = {**entry, 'dashboard': dashboard}
    return result

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--check', action='store_true', help='Validate only (also the default)')
    args = parser.parse_args()
    for name, entry in load_dashboards().items():
        if args.output_dir:
            path = args.output_dir / entry['folder'] / (name + '.json')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(entry['dashboard'], ensure_ascii=False, indent=2) + '\n')
        print(name, entry['dashboard']['uid'], len(entry['dashboard']['panels']), 'panels', entry['folder'])

if __name__ == '__main__': main()
