import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import runpy
import stat
import tempfile
import unittest
from unittest.mock import patch

import local_usage_github as github

fixture = runpy.run_path(str(Path(__file__).with_name('local_usage_github.test.py')))
spec = importlib.util.spec_from_file_location('repair', Path(__file__).with_name('repair-local-usage-github.py'))
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)
AT, CONFIG, Api = fixture['AT'], fixture['CONFIG'], fixture['Api']
IDENTITY = {'commit': 'a' * 40, 'files': {'synthetic.py': 'b' * 64},
            'collector': {'path': 'synthetic-collector.py', 'sha256': 'c' * 64}, 'python': [3, 12, 0]}


class FrozenTime(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return AT.astimezone(tz or dt.timezone.utc)


def capture():
    current = fixture['collect']()
    current['capturedAt'] = current['asOfAt']
    return current


class RepairTests(unittest.TestCase):
    def setUp(self):
        patch.object(dt, 'datetime', FrozenTime).start()
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.file, self.operation = self.root / 'usage' / 'profile.json', self.root / 'operations' / 'one'
        self.file.parent.mkdir()
        self.identity = copy.deepcopy(IDENTITY)
        self.patch_identity = patch.object(repair, 'source_identity', side_effect=lambda collector: copy.deepcopy(self.identity))
        self.patch_identity.start()
        self.addCleanup(self.patch_identity.stop)
        self.current = capture()
        self.collect_patch = patch.object(github, 'collect', side_effect=lambda *args, **kwargs: copy.deepcopy(self.current))
        self.collect = self.collect_patch.start()
        self.addCleanup(patch.stopall)

    def prepare(self):
        self.plan = repair.prepare(self.file, self.operation, CONFIG, Api(), lambda r, c: 'personal', IDENTITY['collector'], at=AT)
        return self.plan['planSha256']

    def seed(self):
        previous = capture()
        previous['sources'][0]['days'].insert(0, {**previous['sources'][0]['days'][0], 'day': '2026-10-01', 'knownPrs': 123})
        previous['sources'].append({'id': 'd' * 64, 'account': 'e' * 64, 'host': 'github.com',
                                    'status': 'unavailable', 'days': []})
        self.original = (json.dumps(previous, indent=2) + '\n').encode()
        self.file.write_bytes(self.original)
        return previous

    def test_sixty_day_plan_binds_span_and_retains_recovery_default_compatibility(self):
        previous = self.seed()
        self.collect_patch.stop()
        try:
            self.current = fixture['collect'](days=60)
        finally:
            self.collect = self.collect_patch.start()
        self.current['capturedAt'] = self.current['asOfAt']
        earlier = {**copy.deepcopy(previous['sources'][0]['days'][0]), 'day': '2026-08-01'}
        previous['sources'][0]['days'].insert(0, earlier)
        self.original = (json.dumps(previous, indent=2) + '\n').encode()
        self.file.write_bytes(self.original)
        with self.assertRaisesRegex(ValueError, 'requested bounded span'):
            self.prepare()
        self.assertEqual(self.file.read_bytes(), self.original)
        plan = repair.prepare(self.file, self.operation, CONFIG, Api(), lambda r, c: 'personal', IDENTITY['collector'], at=AT, days=60)
        self.assertEqual(plan['operationWindow']['startDay'], '2026-09-11')
        self.assertEqual(self.file.read_bytes(), self.original)
        digest = plan['planSha256']
        self.assertEqual(repair.apply(self.file, self.operation, digest, at=AT), 'applied')
        self.assertEqual(repair.apply(self.file, self.operation, digest, at=AT), 'unchanged')
        result = json.loads(self.file.read_bytes())
        self.assertEqual(result['sources'][0]['days'][0], earlier)
        self.assertEqual(len(result['sources'][0]['days']), 61)
        with self.assertRaises(ValueError):
            repair.apply(self.file, self.operation, digest, at=AT + dt.timedelta(days=1))
        self.assertEqual(repair.restore(self.file, self.operation, digest), 'restored')
        self.assertEqual(self.file.read_bytes(), self.original)

    def test_prepare_is_private_dry_run_and_preserves_old_history_and_unrelated_paths(self):
        previous = self.seed()
        others = {self.root / name: ('synthetic-' + name).encode() for name in ['tokens.json', 'report.md', 'config.json', 'archive.json']}
        for path, data in others.items():
            path.write_bytes(data)
        digest = self.prepare()
        self.assertEqual(self.file.read_bytes(), self.original)
        self.assertFalse(self.plan['targetWritten'])
        self.assertEqual((self.operation / 'before.bin').read_bytes(), self.original)
        self.assertEqual(stat.S_IMODE(self.operation.stat().st_mode), 0o700)
        for path in self.operation.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(self.plan['operationWindow'], {'timeZone': 'Asia/Shanghai', 'startDay': '2026-11-03',
                                                       'endDay': '2026-11-09', 'todayPartial': True})
        self.assertEqual(repair.apply(self.file, self.operation, digest, at=AT), 'applied')
        saved = self.file.read_bytes()
        result = json.loads(saved)
        self.assertEqual(result['sources'][0]['days'][0], previous['sources'][0]['days'][0])
        self.assertEqual(result['sources'][1], previous['sources'][1])
        self.assertTrue(result['sources'][0]['days'][-1]['inProgress'])
        self.assertEqual(repair.apply(self.file, self.operation, digest, at=AT), 'unchanged')
        self.assertEqual(self.file.read_bytes(), saved)
        self.assertEqual(repair.restore(self.file, self.operation, digest), 'restored')
        self.assertEqual(self.file.read_bytes(), self.original)
        self.assertEqual(repair.restore(self.file, self.operation, digest), 'unchanged')
        for path, data in others.items():
            self.assertEqual(path.read_bytes(), data)

    def test_initial_absence_can_be_applied_and_restored_without_touching_siblings(self):
        digest = self.prepare()
        self.assertIsNone(self.plan['beforeHash'])
        self.assertFalse(self.file.exists())
        self.assertFalse((self.operation / 'before.bin').exists())
        self.assertEqual(repair.apply(self.file, self.operation, digest, at=AT), 'applied')
        self.assertEqual(stat.S_IMODE(self.file.stat().st_mode), 0o600)
        self.assertEqual(repair.restore(self.file, self.operation, digest), 'restored')
        self.assertFalse(self.file.exists())
        self.assertEqual(repair.restore(self.file, self.operation, digest), 'unchanged')

    def test_invalid_definition_scope_cutoff_and_unavailable_source_cannot_prepare(self):
        original = capture()
        changes = [lambda v: v.update(metricDefinition='legacy'), lambda v: v.update(dateBasis={}),
                   lambda v: v.update(qualification='exact'), lambda v: v.update(activeSourceIds=[]),
                   lambda v: v['sources'].append(copy.deepcopy(v['sources'][0])),
                   lambda v: v['sources'][0].update(status='unavailable', days=[]),
                   lambda v: v['sources'][0]['days'][0].update(day='2026-11-02'),
                   lambda v: v['sources'][0]['days'][-1].update(inProgress=False),
                   lambda v: v['sources'][0]['days'][0].update(chinaCommits=0),
                   lambda v: v['sources'][0]['days'][0].update(rawPrs=-1),
                   lambda v: v['sources'][0]['days'][-1]['repositories'][0].update(category='invalid'),
                   lambda v: v['sources'][0]['days'][-1].update(profileCommits=999),
                   lambda v: v.update(asOfAt='2099-01-01T00:00:00Z')]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                self.current = copy.deepcopy(original)
                change(self.current)
                with self.assertRaises((ValueError, KeyError)):
                    self.prepare()
                self.assertFalse(self.file.exists())
                self.assertFalse((self.operation / 'plan.json').exists())

    def test_unadmitted_configuration_and_unreadable_existing_target_refuse_before_api(self):
        with self.assertRaises(ValueError):
            repair.prepare(self.file, self.operation, {}, Api(), lambda r, c: 'personal', IDENTITY['collector'], at=AT)
        self.file.write_bytes(b'not-json')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(self.file.read_bytes(), b'not-json')
        self.collect.assert_not_called()

    def test_stable_account_change_preserves_earlier_history_and_target_bytes(self):
        self.seed()
        self.current['sources'][0]['account'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'account identity'):
            self.prepare()
        self.assertEqual(self.file.read_bytes(), self.original)
        self.assertFalse(self.operation.exists())

    def test_apply_recomputes_china_day_and_refuses_yesterday_plan_but_restore_remains_possible(self):
        self.seed()
        digest = self.prepare()
        with self.assertRaisesRegex(ValueError, 'execution dates'):
            repair.apply(self.file, self.operation, digest, at=AT + dt.timedelta(days=1))
        self.assertEqual(self.file.read_bytes(), self.original)
        self.assertEqual(repair.apply(self.file, self.operation, digest, at=AT), 'applied')
        self.assertEqual(repair.restore(self.file, self.operation, digest), 'restored')

    def test_target_changes_prevent_both_apply_and_restore(self):
        self.seed()
        digest = self.prepare()
        self.file.write_bytes(b'synthetic-concurrent-change')
        for action in [lambda: repair.apply(self.file, self.operation, digest, at=AT),
                       lambda: repair.restore(self.file, self.operation, digest)]:
            with self.assertRaisesRegex(ValueError, 'Concurrent target change'):
                action()
            self.assertEqual(self.file.read_bytes(), b'synthetic-concurrent-change')

    def test_later_writer_after_apply_cannot_be_overwritten_by_restore(self):
        self.seed()
        digest = self.prepare()
        repair.apply(self.file, self.operation, digest, at=AT)
        self.file.write_bytes(b'synthetic-later-writer')
        with self.assertRaisesRegex(ValueError, 'Concurrent target change'):
            repair.restore(self.file, self.operation, digest)
        self.assertEqual(self.file.read_bytes(), b'synthetic-later-writer')
        self.assertEqual((self.operation / 'before.bin').read_bytes(), self.original)

    def test_real_collect_and_replace_are_used_with_synthetic_api_only(self):
        self.collect_patch.stop()
        api = Api()
        result = repair.prepare(self.file, self.operation, CONFIG, api, lambda r, c: 'personal', IDENTITY['collector'], at=AT)
        self.assertEqual(len(api.calls), 2)
        self.assertFalse(self.file.exists())
        repair.apply(self.file, self.operation, result['planSha256'])
        saved = json.loads(self.file.read_bytes())
        self.assertEqual(sum(row['profileCommits'] for row in saved['sources'][0]['days']), 107)
        self.assertTrue(all(row['chinaCommits'] is None for row in saved['sources'][0]['days']))

    def test_interrupted_preparation_has_no_applicable_plan_and_does_not_change_target(self):
        self.seed()
        original_write = repair.atomic_bytes
        def interrupted(file, data):
            if file.name == 'after.json':
                raise KeyboardInterrupt('synthetic interruption during preparation')
            original_write(file, data)
        with patch.object(repair, 'atomic_bytes', side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                self.prepare()
        self.assertEqual((self.operation / 'before.bin').read_bytes(), self.original)
        self.assertEqual(self.file.read_bytes(), self.original)
        self.assertFalse((self.operation / 'plan.json').exists())
        with self.assertRaisesRegex(ValueError, 'reviewed hash'):
            repair.apply(self.file, self.operation, '0' * 64, at=AT)

    def test_plan_payload_snapshot_and_source_runtime_are_bound(self):
        self.seed()
        digest = self.prepare()
        with self.assertRaisesRegex(ValueError, 'reviewed hash'):
            repair.apply(self.file, self.operation, '0' * 64, at=AT)
        self.identity['commit'] = '1' * 40
        with self.assertRaisesRegex(ValueError, 'source/runtime'):
            repair.apply(self.file, self.operation, digest, at=AT)
        self.identity = copy.deepcopy(IDENTITY)
        for name in ['before.bin', 'capture.json', 'after.json']:
            path = self.operation / name
            data = path.read_bytes()
            path.write_bytes(data + b' ')
            with self.assertRaisesRegex(ValueError, 'snapshot or payload changed'):
                repair.apply(self.file, self.operation, digest, at=AT)
            path.write_bytes(data)
        self.assertEqual(self.file.read_bytes(), self.original)

    def test_calendar_window_is_not_a_stale_example_and_crosses_leap_day_and_year(self):
        for value, expected in [('2024-03-01T00:01:00+08:00', '2024-02-24'),
                                ('2026-01-01T23:59:59+08:00', '2025-12-26')]:
            with self.subTest(value=value):
                at = github.instant(value)
                first, last = github.capture_window(at)
                current = capture()
                current.update(asOfAt=github.stamp(at), capturedAt=github.stamp(at), operationWindow={
                    'timeZone': 'Asia/Shanghai', 'startDay': str(first), 'endDay': str(last), 'todayPartial': True})
                for index, row in enumerate(current['sources'][0]['days']):
                    row.update(day=str(first + dt.timedelta(days=index)), capturedAt=github.stamp(at), inProgress=index == 6)
                self.assertEqual(str(first), expected)
                repair.validate_capture(current, at)
                with self.assertRaisesRegex(ValueError, 'execution dates'):
                    repair.validate_capture(current, at + dt.timedelta(days=1))

    def test_source_pin_checks_committed_module_bytes_and_external_collector_bytes(self):
        self.patch_identity.stop()
        code = b'synthetic-source\n'
        for name in repair.SOURCE_FILES:
            file = self.root / name
            file.parent.mkdir(exist_ok=True)
            file.write_bytes(code)
        collector_file = self.root / 'collector.py'
        collector_file.write_bytes(code)
        collector = {'path': str(collector_file), 'sha256': repair.sha(code)}
        def git_read(args, **kwargs):
            return 'a' * 40 if args[1] == 'rev-parse' else code
        with patch.object(repair, 'ROOT', self.root), patch.object(repair.subprocess, 'check_output', side_effect=git_read):
            self.assertEqual(repair.source_identity(collector)['files'], {name: repair.sha(code) for name in repair.SOURCE_FILES})
            module = self.root / repair.SOURCE_FILES[0]
            module.write_bytes(b'changed-source')
            with self.assertRaisesRegex(ValueError, 'fixed commit'):
                repair.source_identity(collector)
            module.write_bytes(code)
            collector_file.write_bytes(b'changed-collector')
            with self.assertRaisesRegex(ValueError, 'Collector source pin'):
                repair.source_identity(collector)

    def test_uses_the_refresh_target_lock_for_prepare_apply_and_restore(self):
        self.seed()
        digest = self.prepare()
        with github.target_lock(self.file):
            for action in [lambda: self.prepare(), lambda: repair.apply(self.file, self.operation, digest, at=AT),
                           lambda: repair.restore(self.file, self.operation, digest)]:
                with self.assertRaises(OSError):
                    action()
        self.assertEqual(self.file.read_bytes(), self.original)
        self.assertEqual(repair.apply(self.file, self.operation, digest, at=AT), 'applied')

    def test_interruption_after_replace_is_recoverable_without_a_second_write(self):
        self.seed()
        digest = self.prepare()
        original_write = repair.atomic_bytes
        def interrupted(file, data):
            original_write(file, data)
            raise KeyboardInterrupt('synthetic interruption after atomic replacement')
        with patch.object(repair, 'atomic_bytes', side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                repair.apply(self.file, self.operation, digest, at=AT)
        self.assertEqual(repair.apply(self.file, self.operation, digest, at=AT), 'unchanged')
        self.assertEqual(repair.restore(self.file, self.operation, digest), 'restored')
        self.assertEqual(self.file.read_bytes(), self.original)

    def test_interruption_before_replace_preserves_target_and_snapshot(self):
        self.seed()
        digest = self.prepare()
        with patch.object(repair.os, 'replace', side_effect=OSError('synthetic interrupted rename')):
            with self.assertRaises(OSError):
                repair.apply(self.file, self.operation, digest, at=AT)
        self.assertEqual(self.file.read_bytes(), self.original)
        self.assertEqual(repair.restore(self.file, self.operation, digest), 'unchanged')
        self.assertEqual((self.operation / 'before.bin').read_bytes(), self.original)

    @unittest.skipIf(os.name == 'nt', 'Directory fsync is POSIX-specific')
    def test_prepare_syncs_each_new_directory_entry_before_plan_is_available(self):
        self.file = self.root / 'targets' / 'nested' / 'profile.json'
        self.operation = self.root / 'recovery' / 'nested' / 'one'
        events = []
        mkdir, sync, write = Path.mkdir, repair.sync_directory, repair.atomic_bytes

        def create(directory, *args, **kwargs):
            absent = not directory.exists()
            result = mkdir(directory, *args, **kwargs)
            if absent:
                events.append(('mkdir', directory))
            return result

        def synced(directory):
            sync(directory)
            events.append(('sync', directory))

        def written(file, data):
            events.append(('write', file))
            write(file, data)

        with patch.object(Path, 'mkdir', new=create), patch.object(repair, 'sync_directory', side_effect=synced), \
                patch.object(repair, 'atomic_bytes', side_effect=written):
            self.prepare()
        created = [path for event, path in events if event == 'mkdir']
        self.assertEqual(created, [self.root / 'targets', self.file.parent, self.root / 'recovery',
                                   self.operation.parent, self.operation])
        plan_index = events.index(('write', self.operation / 'plan.json'))
        for directory in created:
            index = events.index(('mkdir', directory))
            self.assertEqual(events[index + 1], ('sync', directory.parent))
            self.assertLess(index + 1, plan_index)
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        self.assertFalse(self.file.exists())

    @unittest.skipIf(os.name == 'nt', 'Directory fsync is POSIX-specific')
    def test_failed_mkdir_parent_sync_refuses_plan_and_retry_syncs_existing_ancestor(self):
        self.seed()
        self.operation = self.root / 'recovery' / 'nested' / 'one'
        sync = repair.sync_directory

        def failed(directory):
            if directory == self.root and (self.root / 'recovery').exists():
                raise OSError('synthetic new directory parent fsync failure')
            sync(directory)

        with patch.object(repair, 'sync_directory', side_effect=failed):
            with self.assertRaisesRegex(OSError, 'parent fsync'):
                self.prepare()
        self.assertTrue((self.root / 'recovery').is_dir())
        self.assertFalse(self.operation.parent.exists())
        self.assertFalse((self.operation / 'plan.json').exists())
        self.assertEqual(self.file.read_bytes(), self.original)

        events = []
        mkdir = Path.mkdir

        def create(directory, *args, **kwargs):
            events.append(('mkdir', directory))
            return mkdir(directory, *args, **kwargs)

        def synced(directory):
            sync(directory)
            events.append(('sync', directory))

        self.operation = self.operation.with_name('two')
        with patch.object(Path, 'mkdir', new=create), patch.object(repair, 'sync_directory', side_effect=synced):
            self.prepare()
        self.assertLess(events.index(('sync', self.root)), events.index(('mkdir', self.operation.parent)))
        self.assertEqual(self.file.read_bytes(), self.original)

    @unittest.skipIf(os.name == 'nt', 'Directory fsync is POSIX-specific')
    def test_apply_retry_finishes_directory_fsync_after_rename_without_replacement(self):
        self.seed()
        digest = self.prepare()
        fsync = os.fsync

        def interrupted(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError('synthetic post-rename directory fsync failure')
            fsync(fd)

        with patch.object(os, 'fsync', side_effect=interrupted):
            with self.assertRaisesRegex(OSError, 'post-rename'):
                repair.apply(self.file, self.operation, digest, at=AT)
        self.assertEqual(self.file.read_bytes(), (self.operation / 'after.json').read_bytes())
        self.assertEqual((self.operation / 'before.bin').read_bytes(), self.original)
        with patch.object(repair.os, 'replace', side_effect=AssertionError('must not replace again')), \
                patch.object(repair, 'sync_directory', wraps=repair.sync_directory) as sync:
            self.assertEqual(repair.apply(self.file, self.operation, digest, at=AT), 'unchanged')
        sync.assert_called_once_with(self.file.parent)
        with patch.object(repair, 'sync_directory', side_effect=OSError('still not durable')):
            with self.assertRaisesRegex(OSError, 'still not durable'):
                repair.apply(self.file, self.operation, digest, at=AT)

    @unittest.skipIf(os.name == 'nt', 'Directory fsync is POSIX-specific')
    def test_restore_retry_finishes_directory_fsync_after_rename_without_replacement(self):
        self.seed()
        digest = self.prepare()
        repair.apply(self.file, self.operation, digest, at=AT)
        fsync = os.fsync

        def interrupted(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError('synthetic restore post-rename directory fsync failure')
            fsync(fd)

        with patch.object(os, 'fsync', side_effect=interrupted):
            with self.assertRaisesRegex(OSError, 'post-rename'):
                repair.restore(self.file, self.operation, digest)
        self.assertEqual(self.file.read_bytes(), self.original)
        with patch.object(repair.os, 'replace', side_effect=AssertionError('must not replace again')), \
                patch.object(repair, 'sync_directory', wraps=repair.sync_directory) as sync:
            self.assertEqual(repair.restore(self.file, self.operation, digest), 'unchanged')
        sync.assert_called_once_with(self.file.parent)

    @unittest.skipIf(os.name == 'nt', 'Directory fsync is POSIX-specific')
    def test_restore_initial_absence_syncs_deletion_and_retry_completes_pending_sync(self):
        digest = self.prepare()
        repair.apply(self.file, self.operation, digest, at=AT)
        with patch.object(repair, 'sync_directory', side_effect=OSError('synthetic deletion fsync failure')) as sync:
            with self.assertRaisesRegex(OSError, 'deletion fsync'):
                repair.restore(self.file, self.operation, digest)
        sync.assert_called_once_with(self.file.parent)
        self.assertFalse(self.file.exists())
        self.assertTrue((self.operation / 'plan.json').is_file())
        with patch.object(repair, 'sync_directory', side_effect=OSError('still not durable')):
            with self.assertRaisesRegex(OSError, 'still not durable'):
                repair.restore(self.file, self.operation, digest)
        with patch.object(Path, 'unlink', side_effect=AssertionError('must not unlink again')), \
                patch.object(repair, 'sync_directory', wraps=repair.sync_directory) as sync:
            self.assertEqual(repair.restore(self.file, self.operation, digest), 'unchanged')
        sync.assert_called_once_with(self.file.parent)
        self.assertFalse(self.file.exists())

    @unittest.skipIf(os.name == 'nt', 'Synthetic symlink requires POSIX permissions')
    def test_symlink_target_is_not_read_or_replaced(self):
        other = self.root / 'unrelated.json'
        other.write_bytes(b'synthetic-private-unrelated')
        self.file.symlink_to(other)
        with self.assertRaises(OSError):
            self.prepare()
        self.assertEqual(other.read_bytes(), b'synthetic-private-unrelated')


if __name__ == '__main__':
    unittest.main()
