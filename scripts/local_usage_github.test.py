import copy
import datetime as dt
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import local_usage_github as github

AT = dt.datetime.fromisoformat('2026-11-09T08:24:11+00:00')
PROFILE = {'host': 'github.com', 'profile': 'personal', 'login': 'fixture-owner'}
CONFIG = {'githubHelper': '/fixture/helper', 'githubProfiles': [PROFILE],
          'githubContributionSource': github.DEFINITION}


def repo(name='sample/project', fork=False):
    return {'id': name, 'nameWithOwner': name, 'isFork': fork, 'isPrivate': False,
            'defaultBranchRef': {'name': 'main'}}


def pr(key, at, fork=False):
    return {'occurredAt': at, 'pullRequest': {'id': key, 'createdAt': at,
            'author': {'login': PROFILE['login']}, 'repository': repo(fork=fork)}}


class Api:
    def __init__(self):
        self.calls = []
        self.prs = [pr('one', '2026-11-08T16:01:00Z'), pr('two', '2026-11-08T15:59:00Z')]
        self.commit_nodes = [{'occurredAt': '2026-11-08T00:00:00Z', 'commitCount': 7},
                             {'occurredAt': '2026-11-09T00:00:00Z', 'commitCount': 100}]
        self.edit = lambda response, fields: None

    def __call__(self, args, timeout):
        self.calls.append(args)
        assert 0 < timeout <= 30
        fields = dict(arg.split('=', 1) for i, arg in enumerate(args) if i and args[i-1] == '-f')
        offset = 1 if fields.get('after') else 0
        total = sum(row['commitCount'] for row in self.commit_nodes)
        connection = {'totalCount': len(self.prs), 'pageInfo': {
            'hasNextPage': len(self.prs) > 1 and not offset, 'endCursor': 'next' if not offset else None},
            'nodes': self.prs[offset:offset+1]}
        collection = {'startedAt': fields['from'], 'endedAt': fields['to'],
            'hasAnyRestrictedContributions': False, 'restrictedContributionsCount': 0,
            'totalCommitContributions': total, 'totalRepositoriesWithContributedCommits': 1,
            'totalPullRequestContributions': len(self.prs),
            'commitContributionsByRepository': [{'repository': repo(), 'contributions': {
                'totalCount': total, 'nodes': self.commit_nodes, 'pageInfo': {'hasNextPage': False}}}],
            'pullRequestContributions': connection}
        response = {'data': {'viewer': {'id': 'account', 'login': PROFILE['login'],
            'url': 'https://github.com/' + PROFILE['login'], 'contributionsCollection': collection}}}
        self.edit(response, fields)
        return json.dumps(response)


def collect(api=None, at=AT, config=CONFIG):
    return github.collect(config, api or Api(), lambda remote, config: 'personal', at=at)


class ProfileTests(unittest.TestCase):
    def test_multiple_commits_per_day_and_paginated_prs_have_distinct_date_bases(self):
        api = Api()
        result = collect(api)
        source = result['sources'][0]
        self.assertEqual(source['status'], 'ready')
        self.assertEqual(len(api.calls), 2)
        self.assertIn('maxRepositories: 100', github.QUERY)
        self.assertIn('excludeFirst: false, excludePopular: false', github.QUERY)
        days = {row['day']: row for row in source['days']}
        self.assertEqual([days[d]['profileCommits'] for d in ['2026-11-08', '2026-11-09']], [7, 100])
        self.assertEqual([days[d]['knownPrs'] for d in ['2026-11-08', '2026-11-09']], [1, 1])
        self.assertEqual(days['2026-11-08']['profilePrs'], 2)
        self.assertTrue(all(row['chinaCommits'] is None and row['status'] == 'partial' for row in days.values()))
        self.assertTrue(days['2026-11-09']['inProgress'])
        self.assertFalse(days['2026-11-08']['inProgress'])
        self.assertEqual(days['2026-11-07']['profileCommits'], 0)
        self.assertNotIn('"one"', json.dumps(result))
        self.assertEqual(result['qualification'], 'nonfork-at-capture')

    def test_forks_are_diagnostic_only_and_private_nonfork_is_in_known_subset(self):
        api = Api()
        api.prs[0]['pullRequest']['repository']['isFork'] = True
        api.prs[1]['pullRequest']['repository']['isPrivate'] = True
        days = collect(api)['sources'][0]['days']
        self.assertEqual(sum(row['rawPrs'] for row in days), 2)
        self.assertEqual(sum(row['knownPrs'] for row in days), 1)
        self.assertEqual(sum(row['excludedForkPrs'] for row in days), 1)
        self.assertTrue(all(row['status'] == 'partial' for row in days))

    def test_restricted_mixed_types_never_become_typed_zero_or_exact_totals(self):
        api = Api()
        def edit(response, fields):
            collection = response['data']['viewer']['contributionsCollection']
            collection.update(hasAnyRestrictedContributions=True, restrictedContributionsCount=12)
        api.edit = edit
        source = collect(api)['sources'][0]
        self.assertEqual(source['status'], 'partial')
        self.assertEqual(source['restrictedContributions'], 12)
        self.assertEqual(sum(row['knownPrs'] for row in source['days']), 2)
        self.assertEqual(sum(row['profileCommits'] for row in source['days']), 107)

    def test_incomplete_or_inconsistent_api_is_unavailable_not_zero(self):
        def change_collection(key, value):
            return lambda response, fields: response['data']['viewer']['contributionsCollection'].__setitem__(key, value)
        def change_commits(key, value):
            return lambda response, fields: response['data']['viewer']['contributionsCollection']['commitContributionsByRepository'][0]['contributions'].__setitem__(key, value)
        cases = {
            'errors': lambda r, f: r.update(errors=[{'message': 'synthetic'}]),
            'identity': lambda r, f: r['data']['viewer'].update(login='other'),
            'host': lambda r, f: r['data']['viewer'].update(url='https://other.ghe.com/fixture-owner'),
            'repo_limit': change_collection('totalRepositoriesWithContributedCommits', 101),
            'commit_total': change_collection('totalCommitContributions', 108),
            'count_is_not_days': change_commits('totalCount', 2),
            'commit_pages': change_commits('pageInfo', {'hasNextPage': True}),
            'pr_total': change_collection('totalPullRequestContributions', 3),
            'pr_incomplete': lambda r, f: r['data']['viewer']['contributionsCollection']['pullRequestContributions']['pageInfo'].update(hasNextPage=False),
            'cursor': lambda r, f: r['data']['viewer']['contributionsCollection']['pullRequestContributions']['pageInfo'].update(endCursor='next', hasNextPage=True),
            'capture': change_collection('endedAt', '2026-11-08T08:00:00Z'),
            'changed_scope': lambda r, f: r['data']['viewer'].update(id='other' if f.get('after') else 'account'),
            'fork_shape': lambda r, f: r['data']['viewer']['contributionsCollection']['pullRequestContributions']['nodes'][0]['pullRequest']['repository'].update(isFork=None),
        }
        for name, edit in cases.items():
            with self.subTest(name=name):
                api = Api()
                api.edit = edit
                source = collect(api)['sources'][0]
                self.assertEqual(source['status'], 'unavailable')
                self.assertEqual(source['days'], [])

    def test_duplicate_repo_days_and_pr_ids_are_rejected(self):
        for kind in ['repo', 'day', 'pr']:
            with self.subTest(kind=kind):
                api = Api()
                if kind == 'pr':
                    api.prs[1]['pullRequest']['id'] = 'one'
                elif kind == 'day':
                    api.commit_nodes[1]['occurredAt'] = api.commit_nodes[0]['occurredAt']
                else:
                    def edit(r, f):
                        c = r['data']['viewer']['contributionsCollection']
                        c['commitContributionsByRepository'] *= 2
                        c['totalRepositoriesWithContributedCommits'] = 2
                    api.edit = edit
                self.assertEqual(collect(api)['sources'][0]['status'], 'unavailable')

    def test_profile_day_label_is_not_converted_to_china_and_future_bucket_is_unknown(self):
        api = Api()
        api.prs = [pr('boundary', '2026-11-08T16:01:00Z')]
        api.commit_nodes = [{'occurredAt': '2026-11-08T23:59:59Z', 'commitCount': 7}]
        result = collect(api, dt.datetime.fromisoformat('2026-11-08T17:00:00+00:00'))
        days = {row['day']: row for row in result['sources'][0]['days']}
        self.assertEqual(days['2026-11-08']['profileCommits'], 7)
        self.assertIsNone(days['2026-11-09']['profileCommits'])
        self.assertEqual(days['2026-11-09']['knownPrs'], 1)
        self.assertIsNone(days['2026-11-09']['repositories'][0]['profileCommits'])

    def test_pr_source_label_can_precede_created_at_at_the_guard_boundary(self):
        api = Api()
        api.prs = [pr('guard', '2026-11-02T00:00:00Z')]
        api.prs[0]['occurredAt'] = '2026-11-01T23:59:59Z'
        self.assertEqual(collect(api)['sources'][0]['status'], 'ready')
        self.assertEqual(sum(row['knownPrs'] for row in collect(api)['sources'][0]['days']), 0)

    def test_window_recomputed_across_leap_day_and_year(self):
        for at, first, last in [('2024-03-01T00:00:00+08:00', '2024-02-24', '2024-03-01'),
                                ('2026-01-01T16:00:00+00:00', '2025-12-27', '2026-01-02')]:
            self.assertEqual(tuple(map(str, github.capture_window(dt.datetime.fromisoformat(at)))), (first, last))
        with self.assertRaises(ValueError):
            collect(at=dt.datetime(2026, 11, 9))

    def test_scope_and_boolean_counts_fail_closed(self):
        for config in [{**CONFIG, 'githubProfiles': [PROFILE, PROFILE]}, {**CONFIG, 'githubProfiles': []}]:
            with self.assertRaises(ValueError):
                collect(config=config)
        api = Api()
        api.commit_nodes[0]['commitCount'] = True
        self.assertEqual(collect(api)['sources'][0]['status'], 'unavailable')

    def test_bounded_idempotent_replacement_retains_unavailable_and_earlier_days(self):
        current = collect()
        old = copy.deepcopy(current)
        earlier = {**old['sources'][0]['days'][0], 'day': '2026-10-01', 'knownPrs': 123}
        old['sources'][0]['days'].insert(0, earlier)
        first = github.replace_days(old, current)
        self.assertEqual(first['sources'][0]['days'][0], earlier)
        self.assertEqual(github.replace_days(first, current), first)
        failed = copy.deepcopy(current)
        failed['sources'][0].update(status='unavailable', days=[])
        retained = github.replace_days(first, failed)
        self.assertEqual(retained['sources'][0]['days'][0], earlier)
        self.assertEqual(retained['sources'][0]['days'][-1]['status'], 'stale')
        self.assertEqual(retained['sources'][0]['days'][-1]['profileCommits'], 100)
        before = copy.deepcopy(old)
        bad = copy.deepcopy(current)
        bad['sources'][0]['days'][0]['day'] = '2026-11-02'
        with self.assertRaises(ValueError):
            github.replace_days(old, bad)
        self.assertEqual(old, before)
        with self.assertRaises(ValueError):
            github.replace_days({**old, 'metricDefinition': 'legacy'}, current)

    def test_opt_in_skip_api_private_atomic_output_and_overlap_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'private' / 'profile.json'
            api = Api()
            self.assertIsNone(github.refresh({}, api, lambda r, c: 'personal', file=file))
            self.assertIsNone(github.refresh(CONFIG, api, lambda r, c: 'personal', file=file, skip_api=True))
            self.assertEqual(api.calls, [])
            self.assertFalse(file.exists())
            result = github.refresh(CONFIG, api, lambda r, c: 'personal', file=file, at=AT)
            self.assertEqual(json.loads(file.read_text()), result)
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
            lock = file.with_suffix('.lock')
            lock.mkdir()
            before = file.read_bytes()
            with self.assertRaises(FileExistsError):
                github.refresh(CONFIG, api, lambda r, c: 'personal', file=file, at=AT)
            self.assertEqual(file.read_bytes(), before)
            lock.rmdir()
            with patch.object(github, 'collect', side_effect=ValueError('synthetic')):
                with self.assertRaises(ValueError):
                    github.refresh(CONFIG, api, lambda r, c: 'personal', file=file, at=AT)
            self.assertFalse(lock.exists())
            self.assertEqual(file.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
