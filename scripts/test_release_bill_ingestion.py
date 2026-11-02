import copy
import importlib.util
from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('release-bill-ingestion.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
SHA, DIGEST = 'a'*40, 'sha256:'+'b'*64

def baseline():
    return dict(family=r.BASELINE.split(':')[0],revision=3,taskRoleArn=r.TASK_ROLE,executionRoleArn=r.EXEC_ROLE,
        networkMode='awsvpc',requiresCompatibilities=['FARGATE'],cpu='1024',memory='2048',
        runtimePlatform={'cpuArchitecture':'ARM64','operatingSystemFamily':'LINUX'},
        containerDefinitions=[dict(name='api-sync-legiscan-bills',image='old',
            environment=[{'name':k,'value':v} for k,v in {'DB_HOST':r.HOST,'DB_PORT':'5432','DB_NAME':'capiro','LEGISCAN_REPORT_REFRESH_TENANT':'must-not-copy'}.items()],
            secrets=[{'name':k,'valueFrom':'reference-'+k} for k in ['DB_USER','DB_PASSWORD','LEGISCAN_API_KEY','CLERK_SECRET_KEY']],
            logConfiguration={'logDriver':'awslogs','options':{'awslogs-group':'/capiro/dev/sync-jobs','awslogs-stream-prefix':'ecs'}})])

class ReleaseTests(unittest.TestCase):
    def test_florida_passage_scope_is_explicit_and_cannot_replace_global_schedule(self):
        for phase in ('embed','extract'):
            command=self.task(job='state-passages',passage_states=['FL'],phase=phase)['containerDefinitions'][0]['command']
            self.assertEqual(command[command.index('--states')+1],'FL')
        self.assertNotIn('--states',self.task(job='state-passages')['containerDefinitions'][0]['command'])
        with self.assertRaisesRegex(ValueError,'REQUIRE_STATE_JOB'):self.task(job='federal-passages',passage_states=['FL'])
        with patch('sys.argv',['release','--job','state-passages','--states','FL','--operation','schedule','--commit','--source-sha',SHA,'--limit','1000']),patch.object(r,'aws') as aws:
            with self.assertRaisesRegex(ValueError,'ONE_SHOT'):r.main()
            aws.assert_not_called()

    def test_federal_archive_and_generation_are_pinned_and_secret_minimal(self):
        archive={'type':'hr','hash':'c'*64,'bills':10000}
        task=self.task(job='federal-archive',federal=archive)['containerDefinitions'][0]
        self.assertEqual(task['command'][:5],['import-federal-billstatus-cache','--congress','119','--type','hr'])
        self.assertEqual([s['name'] for s in task['secrets']],['DB_USER','DB_PASSWORD'])
        generation={'hashes':[format(i,'064x') for i in range(8)],'amendment_hash':'d'*64,'amendments':7119,'stage':'hydrate','request_cap':100}
        for stage in ('hydrate','finalize'):
            task=self.task(job='federal-inventory',federal={**generation,'stage':stage})['containerDefinitions'][0]
            self.assertEqual([s['name'] for s in task['secrets']],['DB_USER','DB_PASSWORD'])
            self.assertIn('--amendment-list-hash',task['command'])
        for stage in ('metadata','inventory'):
            with self.assertRaisesRegex(ValueError,'CONGRESS_REFERENCE_REQUIRED'):self.task(job='federal-inventory',federal={**generation,'stage':stage})
            task=self.task(job='federal-inventory',federal={**generation,'stage':stage},congress_arn=f'arn:aws:secretsmanager:{r.REGION}:{r.ACCOUNT}:secret:capiro/dev/congress_gov_api_key-AbCd')['containerDefinitions'][0]
            self.assertEqual([s['name'] for s in task['secrets']],['DB_USER','DB_PASSWORD','CONGRESS_API_KEY'])
        for change in [{'hashes':['a'*64]*8},{'amendment_hash':'latest'},{'request_cap':4801},{'stage':'all'}]:
            with self.assertRaises(ValueError):self.task(job='federal-inventory',federal={**generation,**change})
        for job in ('federal-inventory','federal-archive'):
            with self.assertRaisesRegex(ValueError,'NOT_SCHEDULEABLE'):r.schedule_snapshot(job)

    def test_federal_scope_rejections_precede_cloud_access(self):
        for args in [ ['--job','federal-archive','--federal-type','hr'],['--job','federal-inventory','--archive-hashes',','.join(['a'*64]*8),'--amendment-list-hash','b'*64,'--federal-stage','hydrate'],['--job','state-drain','--federal-stage','metadata'] ]:
            with patch('sys.argv',['release','--source-sha',SHA,*args]),patch.object(r,'aws') as aws:
                with self.assertRaises(ValueError):r.main()
                aws.assert_not_called()

    def test_publisher_only_has_no_provider_key_and_extraction_is_explicit_one_shot(self):
        container=self.task(job='state-drain',publisher_only=True)['containerDefinitions'][0]
        self.assertIn('--publisher-only',container['command'])
        self.assertEqual([s['name'] for s in container['secrets']],['DB_USER','DB_PASSWORD'])
        for job in ('federal-passages','state-passages'):
            c=self.task(job=job,phase='extract')['containerDefinitions'][0]
            self.assertIn('extract',c['command'])
            self.assertEqual([s['name'] for s in c['secrets']],['DB_USER','DB_PASSWORD'])
        for changes in [dict(job='state-dataset',publisher_only=True),dict(job='state-drain',phase='extract')]:
            with self.assertRaises(ValueError):self.task(**changes)
        with patch('sys.argv',['release','--job','state-passages','--source-sha',SHA,'--operation','schedule','--commit','--limit','1000','--phase','extract']),patch.object(r,'aws') as aws:
            with self.assertRaisesRegex(ValueError,'ONE_SHOT'):r.main()
            aws.assert_not_called()
    def test_alternate_only_is_explicit_one_shot_without_provider_credentials(self):
        container = self.task(job='state-drain', alternate_only=True)['containerDefinitions'][0]
        self.assertIn('--alternate-only', container['command'])
        self.assertIn('--publisher-only', container['command'])
        self.assertEqual([s['name'] for s in container['secrets']], ['DB_USER', 'DB_PASSWORD'])
        self.assertNotIn('--alternate-only', self.task(job='state-drain')['containerDefinitions'][0]['command'])
        for job in r.JOBS:
            if job != 'state-drain':
                with self.assertRaisesRegex(ValueError, 'ALTERNATE_ONLY_REQUIRES_STATE_DRAIN'):
                    self.task(job=job, alternate_only=True)
        for extra in [['--job','state-drain','--operation','schedule','--commit'], ['--job','state-passages','--commit']]:
            with patch('sys.argv', ['release','--source-sha',SHA,'--alternate-only',*extra]), patch.object(r,'aws') as aws:
                with self.assertRaises(ValueError): r.main()
                aws.assert_not_called()

    def test_all_formats_has_one_shared_cap_and_no_provider_credentials(self):
        for limit in (2, 1000):
            container = self.task(job='state-drain', all_formats=True, limit=limit)['containerDefinitions'][0]
            self.assertEqual(container['command'], ['sync-state-text-drain', '--limit', str(min(limit, 100)),
                '--commit', '--expected-host', r.HOST, '--publisher-only', '--all-formats'])
            self.assertEqual([s['name'] for s in container['secrets']], ['DB_USER', 'DB_PASSWORD'])
            self.assertNotIn('LEGISCAN_API_KEY', {e['name'] for e in container['environment']})
        self.assertNotIn('--all-formats', self.task(job='state-drain')['containerDefinitions'][0]['command'])
        with self.assertRaisesRegex(ValueError, 'FORMAT_OPTIONS_CONFLICT'):
            self.task(job='state-drain', all_formats=True, alternate_only=True)
        for job in r.JOBS:
            if job != 'state-drain':
                with self.assertRaisesRegex(ValueError, 'ALL_FORMATS_REQUIRES_STATE_DRAIN'):
                    self.task(job=job, all_formats=True)

    def test_all_formats_cli_rejections_precede_cloud_access(self):
        for extra in [['--job','state-drain','--operation','schedule','--commit'],
                      ['--job','state-passages','--commit'],
                      ['--job','state-drain','--alternate-only','--commit'],
                      ['--job','state-drain','--phase','extract','--commit']]:
            with patch('sys.argv', ['release','--source-sha',SHA,'--all-formats',*extra]), patch.object(r,'aws') as aws:
                with self.assertRaises(ValueError): r.main()
                aws.assert_not_called()

    def test_all_formats_inspect_forwards_the_option_without_writes(self):
        responses = [{'Account': r.ACCOUNT}, {'taskDefinition': baseline()}, {'Targets': []}]
        argv = ['release','--source-sha',SHA,'--job','state-drain','--commit','--all-formats','--limit','2']
        with patch('sys.argv', argv), patch.object(r,'source_sha',return_value=SHA), \
             patch.object(r,'image_digest',return_value=DIGEST), patch.object(r,'network_for',return_value={}), \
             patch.object(r,'aws',side_effect=responses) as aws, patch('builtins.print') as printed:
            r.main()
        self.assertEqual([call.args[:2] for call in aws.call_args_list],
                         [('sts','get-caller-identity'),('ecs','describe-task-definition'),('events','list-targets-by-rule')])
        receipt = json.loads(printed.call_args_list[0].args[0])
        self.assertEqual(receipt['operation'], 'inspect')
        self.assertEqual(receipt['command'], ['sync-state-text-drain','--limit','2','--commit',
                         '--expected-host',r.HOST,'--publisher-only','--all-formats'])

    def test_cached_archive_is_single_state_exact_source_and_has_no_provider_secret(self):
        archive={'state':'NY','session':2188,'hash':'c'*64,'bills':25453}
        for commit in (False,True):
            task=self.task(job='state-archive',states=['NY'],archive=archive,commit=commit,limit=100)
            container=task['containerDefinitions'][0]
            self.assertEqual([s['name'] for s in container['secrets']],['DB_USER','DB_PASSWORD'])
            self.assertEqual(container['command'],['import-state-dataset-cache','--state','NY','--session','2188','--archive-hash','c'*64,'--expected-bills','25453','--limit','100']+(['--commit','--expected-host',r.HOST] if commit else []))
        with self.assertRaisesRegex(ValueError,'STATE_MISMATCH'):self.task(job='state-archive',states=['CA'],archive=archive)
        for change in [{'hash':'latest'},{'bills':50001},{'session':0},{'extra':'injected'}]:
            with self.assertRaises(ValueError):self.task(job='state-archive',states=['NY'],archive={**archive,**change})
        with self.assertRaisesRegex(ValueError,'NOT_SCHEDULEABLE'):r.schedule_snapshot('state-archive')

    def test_archive_scope_failures_precede_any_cloud_call(self):
        for extra in [[],['--archive-hash','c'*64],['--archive-hash','c'*64,'--archive-session','2188','--archive-bills','25453','--operation','schedule','--commit']]:
            with patch('sys.argv',['release','--job','state-archive','--states','NY','--source-sha',SHA,*extra]),patch.object(r,'aws') as aws:
                with self.assertRaises(ValueError):r.main()
                aws.assert_not_called()

    def task(self, **kwargs):
        options=dict(baseline=baseline(),digest=DIGEST,sha=SHA,job='federal-passages',limit=3,states=['CA'],commit=True)
        options.update(kwargs)
        return r.candidate_task(**options)

    def test_scoped_task_preserves_roles_and_has_no_service_or_unrelated_secrets(self):
        task=self.task()
        c=task['containerDefinitions'][0]
        self.assertEqual(task['taskRoleArn'],r.TASK_ROLE)
        self.assertEqual(c['image'],r.IMAGE_PREFIX+DIGEST)
        self.assertEqual([s['name'] for s in c['secrets']],['DB_USER','DB_PASSWORD'])
        env={e['name']:e['value'] for e in c['environment']}
        self.assertEqual(env['DB_HOST'],r.HOST)
        self.assertEqual(env['BILL_FISCAL_YEAR'],'2026')
        self.assertNotIn('LEGISCAN_REPORT_REFRESH_TENANT',env)
        self.assertNotIn('service',task)
        self.assertNotIn('entryPoint',c)

    def test_refuses_foreign_host_role_or_platform(self):
        for mutate in [lambda b:b['containerDefinitions'][0]['environment'][0].update(value='old-main'),
                       lambda b:b.update(taskRoleArn='other-role'),
                       lambda b:b['runtimePlatform'].update(cpuArchitecture='X86_64')]:
            b=baseline();mutate(b)
            with self.assertRaises(ValueError):self.task(baseline=b)

    def test_rejects_ambiguous_db_secret_override(self):
        b=baseline();b['containerDefinitions'][0]['secrets'].append({'name':'DB_HOST','valueFrom':'old-main'})
        with self.assertRaisesRegex(ValueError,'AMBIGUOUS'):self.task(baseline=b)

    def test_invalid_limits_states_and_mutable_images(self):
        for changes in [dict(limit=0),dict(limit=1001),dict(limit=1.5),dict(digest='latest'),dict(sha='main'),dict(states=['ZZ']),dict(states=['CA','CA']),dict(job='migrate')]:
            with self.subTest(changes=changes),self.assertRaises(ValueError):self.task(**changes)

    def test_state_writers_require_commit_and_have_no_schedule_path(self):
        for job in ['state-dataset', 'state-drain']:
            with self.assertRaisesRegex(ValueError,'REQUIRES_COMMIT'):self.task(job=job,commit=False)
            with patch.object(r,'aws') as aws:
                with self.assertRaisesRegex(ValueError,'NOT_SCHEDULEABLE'):r.schedule_snapshot(job)
                aws.assert_not_called()
            task=self.task(job=job,limit=3)
            container=task['containerDefinitions'][0]
            self.assertEqual(container['command'],['backfill-legiscan-datasets'] if job=='state-dataset' else
                ['sync-state-text-drain','--limit','3','--commit','--expected-host',r.HOST])
            self.assertEqual([secret['name'] for secret in container['secrets']],['DB_USER','DB_PASSWORD','LEGISCAN_API_KEY'])
            env={entry['name']:entry['value'] for entry in container['environment']}
            self.assertEqual(env['LEGISCAN_MONTHLY_BUDGET'],'9000')
            self.assertEqual(env['LEGISCAN_DRAIN_CAP'],'3')
            self.assertEqual(env['LEGISCAN_DOCUMENT_REFRESH_CAP'],'3')
            self.assertEqual(env['LEGISCAN_VOTE_REFRESH_CAP'],'25')
            self.assertEqual(env['LEGISCAN_STATES'],'CA')

    def test_dataset_requires_one_state_and_federal_cap_is_bounded(self):
        with self.assertRaisesRegex(ValueError,'ONE_STATE'):self.task(job='state-dataset',states=['CA','NY'])
        with self.assertRaisesRegex(ValueError,'CAP_EXCEEDED'):self.task(job='federal-text',limit=401)

    def test_state_writer_cli_refuses_multi_state_dataset_and_any_new_schedule_before_aws(self):
        for extra in [['--job','state-dataset','--commit','--states','CA,NY'],['--job','state-dataset'],
                      ['--job','state-drain'],['--job','state-drain','--operation','schedule','--commit'],
                      ['--job','state-dataset','--operation','schedule','--commit']]:
            with self.subTest(extra=extra),patch('sys.argv',['release','--source-sha',SHA,*extra]),patch.object(r,'aws') as aws:
                with self.assertRaises(ValueError):r.main()
                aws.assert_not_called()

    def test_federal_requires_known_secret_ref_and_preserves_fy_scope(self):
        with self.assertRaisesRegex(ValueError,'GOVINFO'):self.task(job='federal-text')
        td=self.task(job='federal-text',govinfo_arn=f'arn:aws:secretsmanager:{r.REGION}:{r.ACCOUNT}:secret:capiro/dev/govinfo_api_key-Abc123')
        cmd=td['containerDefinitions'][0]['command']
        self.assertIn('--historical',cmd);self.assertIn('--commit',cmd)
        self.assertEqual(cmd[cmd.index('--collection')+1],'BILLS')

    def test_dry_passage_job_has_no_commit(self):
        self.assertNotIn('--commit',self.task(commit=False)['containerDefinitions'][0]['command'])

    def test_registered_task_accepts_ecs_named_set_reordering_and_defaults(self):
        expected = self.task()
        actual = copy.deepcopy(expected)
        container = actual['containerDefinitions'][0]
        container['environment'].reverse()
        container['secrets'].reverse()
        container['mountPoints'] = []
        actual['revision'] = 1
        r.verify_registered_task(expected, actual)

    def test_registered_task_rejects_changed_missing_extra_and_duplicate_entries(self):
        expected = self.task()
        for field, value_key in [('environment', 'value'), ('secrets', 'valueFrom')]:
            for change in ['changed', 'missing', 'extra', 'duplicate']:
                with self.subTest(field=field, change=change):
                    actual = copy.deepcopy(expected)
                    entries = actual['containerDefinitions'][0][field]
                    if change == 'changed': entries[0][value_key] = 'unexpected'
                    elif change == 'missing': entries.pop()
                    elif change == 'extra': entries.append({'name':'UNEXPECTED',value_key:'unexpected'})
                    else: entries.append(copy.deepcopy(entries[0]))
                    with self.assertRaisesRegex(ValueError,'REGISTERED_CONTAINER_MISMATCH'):
                        r.verify_registered_task(expected, actual)

    def test_registered_task_keeps_command_image_and_role_checks_exact(self):
        expected = self.task()
        for change in ['command', 'image', 'taskRoleArn', 'executionRoleArn', 'runtimePlatform']:
            with self.subTest(change=change):
                actual = copy.deepcopy(expected)
                container = actual['containerDefinitions'][0]
                if change == 'command': container['command'].reverse()
                elif change == 'image': container['image'] = 'unqualified'
                elif change == 'runtimePlatform': actual[change]['cpuArchitecture'] = 'X86_64'
                else: actual[change] = 'unexpected'
                with self.assertRaisesRegex(ValueError,'REGISTERED_'):
                    r.verify_registered_task(expected, actual)

    def test_schedule_rejects_skips_or_error_bearing_receipts(self):
        for events in [[],[{'message':'INGESTION_SKIP {"reason":"already_running"}'}],[{'message':'INGESTION_METRIC {"source":"sync-legiscan-bills","error_count":1}'}]]:
            with self.assertRaisesRegex(ValueError,'RECEIPT_REQUIRED'):r.ingestion_metric(events)
        self.assertEqual(r.ingestion_metric([{'message':'INGESTION_METRIC {"source":"sync-legiscan-bills","error_count":0}'}])['error_count'],0)

    def test_schedule_refuses_non_scheduled_job_and_wrong_source(self):
        with patch.object(r,'aws') as aws:
            with self.assertRaisesRegex(ValueError,'NOT_SCHEDULEABLE'):r.activate_schedule('index',{},'',{}, {'source':'index'})
            with self.assertRaisesRegex(ValueError,'SOURCE_MISMATCH'):r.activate_schedule('state-passages',{},'',{}, {'source':'other'})
            aws.assert_not_called()

    def test_clean_merged_backend_source_is_required(self):
        outputs = {('remote','get-url','origin'):r.SOURCE_REPOSITORY,
            ('rev-parse','--abbrev-ref','HEAD'):'backend-import',
            ('status','--porcelain','--untracked-files=all'):'',
            ('rev-parse','HEAD'):SHA, ('rev-parse','refs/remotes/origin/backend-import'):SHA,
            ('ls-remote','--exit-code',r.SOURCE_REPOSITORY,r.SOURCE_REF):SHA+'\t'+r.SOURCE_REF}
        with patch.object(r,'git',side_effect=lambda *args:outputs[args]):
            self.assertEqual(r.source_sha(SHA),SHA)
            outputs[('rev-parse','--abbrev-ref','HEAD')] = 'HEAD'
            self.assertEqual(r.source_sha(SHA),SHA)
            with self.assertRaisesRegex(ValueError,'INVALID_SOURCE'):r.source_sha('main')
        mutations = [
            (('remote','get-url','origin'),'https://github.com/neo-capiro/capirov2.git','REPOSITORY'),
            (('rev-parse','--abbrev-ref','HEAD'),'main','BACKEND_IMPORT'),
            (('rev-parse','--abbrev-ref','HEAD'),'fix/bill','BACKEND_IMPORT'),
            (('status','--porcelain','--untracked-files=all'),' M scripts/release-bill-ingestion.py','CLEAN'),
            (('status','--porcelain','--untracked-files=all'),'?? injected.py','CLEAN'),
            (('rev-parse','HEAD'),'c'*40,'CHECKOUT'),
            (('rev-parse','refs/remotes/origin/backend-import'),'c'*40,'INTEGRATION'),
            (('ls-remote','--exit-code',r.SOURCE_REPOSITORY,r.SOURCE_REF),'c'*40+'\t'+r.SOURCE_REF,'REMOTE_INTEGRATION'),
            (('ls-remote','--exit-code',r.SOURCE_REPOSITORY,r.SOURCE_REF),SHA+'\trefs/heads/main','REMOTE_INTEGRATION')]
        for key,value,error in mutations:
            with self.subTest(key=key,value=value),patch.object(r,'git',side_effect=lambda *args:({**outputs,key:value})[args]):
                with self.assertRaisesRegex(ValueError,error):r.source_sha(SHA)

    def test_git_commands_are_checkout_scoped_without_shell(self):
        with patch.object(r.subprocess,'check_output',return_value=SHA+'\n') as run:
            self.assertEqual(r.git('rev-parse','HEAD'),SHA)
            run.assert_called_once_with(['git','-C',str(r.ROOT),'rev-parse','HEAD'],text=True,timeout=60)

    def test_image_requires_canonical_immutable_source_tag_and_exact_qualified_digest(self):
        repo={'repositories':[{'repositoryName':'capiro/preview-core','imageTagMutability':'IMMUTABLE'}]}
        image={'imageDetails':[{'imageTags':[SHA],'imageDigest':DIGEST}]}
        with patch.object(r,'aws',side_effect=[repo,image]) as aws:
            self.assertEqual(r.image_digest(SHA,DIGEST,True),DIGEST)
            self.assertEqual(aws.call_args.args,('ecr','describe-images','--repository-name','capiro/preview-core','--image-ids','imageTag='+SHA))
        for change in ['repository','mutable','tag','digest','unqualified','wrong-qualified']:
            bad_repo,bad_image=copy.deepcopy(repo),copy.deepcopy(image)
            qualified=DIGEST
            if change=='repository':bad_repo['repositories'][0]['repositoryName']='capiro/dev/api'
            if change=='mutable':bad_repo['repositories'][0]['imageTagMutability']='MUTABLE'
            if change=='tag':bad_image['imageDetails'][0]['imageTags']=['c'*40]
            if change=='digest':bad_image['imageDetails'][0]['imageDigest']='latest'
            if change=='unqualified':qualified=None
            if change=='wrong-qualified':qualified='sha256:'+'c'*64
            with self.subTest(change=change),patch.object(r,'aws',side_effect=[bad_repo,bad_image]):
                with self.assertRaises(ValueError):r.image_digest(SHA,qualified,True)

    def snapshot(self,job='federal-passages'):
        return {'rule':{'Name':'capiro-dev-fy26-bills-'+job,'State':'ENABLED','ScheduleExpression':r.SCHEDULES[job]},
            'target':{'Id':'fy26-bill-task','Arn':f'arn:aws:ecs:{r.REGION}:{r.ACCOUNT}:cluster/{r.CLUSTER}',
                'RoleArn':f'arn:aws:iam::{r.ACCOUNT}:role/capiro-dev-eventbridge-sync-invoker',
                'Input':json.dumps({'containerOverrides':[{'name':'fy26-bills','command':r.command_for(job,r.SCHEDULE_LIMITS[job],True)}]}),
                'EcsParameters':{'TaskDefinitionArn':f'arn:aws:ecs:{r.REGION}:{r.ACCOUNT}:task-definition/capiro-dev-api-fy26-bills-{job}:2',
                    'TaskCount':1,'LaunchType':'FARGATE','EnableECSManagedTags':False,'EnableExecuteCommand':False,
                    'NetworkConfiguration':{'awsvpcConfiguration':{
                        'Subnets':['subnet-0e38bd390f8961fef','subnet-0920665f91c905f01','subnet-06db79cd21239de19'],
                        'SecurityGroups':['sg-01def4e5c0fe44d4a'],'AssignPublicIp':'DISABLED'}}}}}

    def test_existing_schedules_preserve_caps_crons_and_reject_wrong_owners(self):
        for job,limit,cron in [('federal-text',400,'cron(0 * * * ? *)'),('federal-passages',1000,'cron(10 * * * ? *)'),('state-passages',1000,'cron(20 * * * ? *)')]:
            self.assertEqual(r.SCHEDULE_LIMITS[job],limit)
            self.assertEqual(r.SCHEDULES[job],cron)
            snapshot=self.snapshot(job)
            with patch.object(r,'aws',side_effect=[snapshot['rule'],{'Targets':[snapshot['target']]}]):
                self.assertEqual(r.schedule_snapshot(job),snapshot)
        mutations=[lambda s:s['rule'].update(State='DISABLED'),lambda s:s['rule'].update(ScheduleExpression='cron(30 * * * ? *)'),
            lambda s:s['target'].update(Id='other'),lambda s:s['target'].update(RoleArn='other'),
            lambda s:s['target']['EcsParameters'].update(TaskCount=2),lambda s:s['target'].update(Input='{}'),
            lambda s:s['target']['EcsParameters'].update(TaskDefinitionArn='arn:other'),
            lambda s:s['target']['EcsParameters']['NetworkConfiguration']['awsvpcConfiguration'].update(AssignPublicIp='ENABLED')]
        for mutate in mutations:
            snapshot=self.snapshot();mutate(snapshot)
            with patch.object(r,'aws',side_effect=[snapshot['rule'],{'Targets':[snapshot['target']]}]):
                with self.assertRaises(ValueError):r.schedule_snapshot('federal-passages')

    def test_schedule_replacement_changes_only_existing_task_revision(self):
        for job in r.SCHEDULES:
            current=self.snapshot(job);before=copy.deepcopy(current)
            arn=before['target']['EcsParameters']['TaskDefinitionArn'].rsplit(':',1)[0]+':3'
            def fake_aws(service,operation,*args,payload=None):
                self.assertEqual(service,'events')
                if operation=='describe-rule':return copy.deepcopy(current['rule'])
                if operation=='list-targets-by-rule':return {'Targets':[copy.deepcopy(current['target'])]}
                self.assertEqual(operation,'put-targets')
                self.assertEqual(payload['Rule'],before['rule']['Name'])
                self.assertEqual(len(payload['Targets']),1)
                current['target']=copy.deepcopy(payload['Targets'][0])
                return {'FailedEntryCount':0}
            metric={'source':'sync-federal-legislative-evidence' if job=='federal-text' else 'bill-text:fy26:'+job.split('-')[0]+':test','error_count':0}
            td=self.task(job=job,limit=r.SCHEDULE_LIMITS[job],govinfo_arn=f'arn:aws:secretsmanager:{r.REGION}:{r.ACCOUNT}:secret:capiro/dev/govinfo_api_key-Abc123')
            with patch.object(r,'aws',side_effect=fake_aws):result=r.activate_schedule(job,td,arn,before,metric)
            self.assertEqual(result['previousTaskDefinition'],before['target']['EcsParameters']['TaskDefinitionArn'])
            before['target']['EcsParameters']['TaskDefinitionArn']=arn
            self.assertEqual(current,before)

    def test_schedule_refuses_race_failed_write_and_partial_readback(self):
        before=self.snapshot();td=self.task(limit=1000)
        metric={'source':'bill-text:fy26:federal:test','error_count':0}
        changed=copy.deepcopy(before);changed['target']['EcsParameters']['TaskDefinitionArn']='concurrent'
        with patch.object(r,'schedule_snapshot',return_value=changed),patch.object(r,'aws') as aws:
            with self.assertRaisesRegex(ValueError,'CHANGED_DURING_CANARY'):r.activate_schedule('federal-passages',td,'new',before,metric)
            aws.assert_not_called()
        for result,error in [({'FailedEntryCount':1},'TARGET_FAILED'),({'FailedEntryCount':0},'READBACK_MISMATCH')]:
            with patch.object(r,'schedule_snapshot',return_value=before),patch.object(r,'aws',return_value=result):
                with self.assertRaisesRegex(ValueError,error):r.activate_schedule('federal-passages',td,'new',before,metric)
        with patch.object(r,'aws') as aws:
            with self.assertRaisesRegex(ValueError,'COMMAND_MISMATCH'):r.activate_schedule('federal-passages',self.task(limit=3),'new',before,metric)
            aws.assert_not_called()

    def test_invalid_run_arguments_fail_before_aws(self):
        for extra in [['--limit','1001'],['--states','ZZ'],['--operation','run'],
                      ['--operation','schedule','--commit','--limit','3']]:
            with self.subTest(extra=extra),patch('sys.argv',['release','--job','federal-passages','--source-sha',SHA,*extra]),patch.object(r,'aws') as aws:
                with self.assertRaises(ValueError):r.main()
                aws.assert_not_called()

    def test_schedule_main_requires_successful_exact_image_canary_before_replacing_target(self):
        for failure in [None,'exit','digest','skip','error']:
            with self.subTest(failure=failure),tempfile.TemporaryDirectory() as directory:
                current=self.snapshot();before=copy.deepcopy(current);calls=[]
                arn=current['target']['EcsParameters']['TaskDefinitionArn'].rsplit(':',1)[0]+':3'
                task_arn=f'arn:aws:ecs:{r.REGION}:{r.ACCOUNT}:task/{r.CLUSTER}/synthetic'
                def fake_aws(service,operation,*args,payload=None):
                    calls.append((service,operation))
                    if service=='sts':return {'Account':r.ACCOUNT}
                    if operation=='describe-repositories':return {'repositories':[{'repositoryName':r.REPOSITORY,'imageTagMutability':'IMMUTABLE'}]}
                    if operation=='describe-images':return {'imageDetails':[{'imageTags':[SHA],'imageDigest':DIGEST}]}
                    if operation=='describe-task-definition':return {'taskDefinition':baseline()}
                    if operation=='describe-rule':return copy.deepcopy(current['rule'])
                    if operation=='list-targets-by-rule':return {'Targets':[copy.deepcopy(current['target'])]}
                    if operation=='register-task-definition':return {'taskDefinition':{**payload,'taskDefinitionArn':arn}}
                    if operation=='run-task':return {'tasks':[{'taskArn':task_arn}]}
                    if operation=='describe-tasks':return {'tasks':[{'taskArn':task_arn,'taskDefinitionArn':arn,'lastStatus':'STOPPED',
                        'containers':[{'name':'fy26-bills','exitCode':1 if failure=='exit' else 0,
                            'imageDigest':'sha256:'+'c'*64 if failure=='digest' else DIGEST}]}]}
                    if operation=='get-log-events':
                        events=[] if failure=='skip' else [{'message':'INGESTION_METRIC '+json.dumps({'source':'bill-text:fy26:federal:test','error_count':1 if failure=='error' else 0})}]
                        return {'events':events}
                    self.assertEqual((service,operation),('events','put-targets'))
                    current['target']=copy.deepcopy(payload['Targets'][0])
                    return {'FailedEntryCount':0}
                receipt=Path(directory)/'receipt.json'
                argv=['release','--job','federal-passages','--operation','schedule','--limit','1000','--commit',
                    '--source-sha',SHA,'--qualified-digest',DIGEST,'--receipt',str(receipt)]
                with patch('sys.argv',argv),patch.object(r,'source_sha',return_value=SHA) as source,patch.object(r,'aws',side_effect=fake_aws),patch.object(r.time,'sleep'),patch('builtins.print'):
                    if failure is None:r.main()
                    else:
                        with self.assertRaises(ValueError):r.main()
                result=json.loads(receipt.read_text())
                self.assertEqual(result['scheduleBefore'],before)
                self.assertEqual(result['taskDefinition'],arn)
                if failure is None:
                    self.assertEqual(source.call_count,2)
                    self.assertLess(calls.index(('logs','get-log-events')),calls.index(('events','put-targets')))
                    self.assertEqual(current['target']['EcsParameters']['TaskDefinitionArn'],arn)
                    self.assertEqual(result['schedule']['previousTaskDefinition'],before['target']['EcsParameters']['TaskDefinitionArn'])
                else:
                    self.assertNotIn(('events','put-targets'),calls)
                    self.assertEqual(current,before)

if __name__=='__main__':unittest.main(verbosity=2)
