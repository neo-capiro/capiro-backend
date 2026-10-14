#!/usr/bin/env python3
import os,sys,json,pathlib
with pathlib.Path(os.environ['MOCK_TRACE']).open('a') as f:f.write(json.dumps({'tool':pathlib.Path(sys.argv[0]).name,'args':sys.argv[1:]})+'\n')
args=sys.argv[1:]
if pathlib.Path(sys.argv[0]).name=='tsx':sys.exit(int(os.environ.get('MOCK_TASK_EXIT','0')))
if args==[os.environ['PE_COMPOSE_DATABASE_URL_JS']]:print('postgresql://fixture:fixture@127.0.0.1:1/fixture');sys.exit(0)
if args==['./node_modules/prisma/build/index.js','migrate','deploy','--schema=./prisma/schema.prisma']:sys.exit(int(os.environ['MOCK_MIGRATE_EXIT']))
if args==['dist/main.js']:sys.exit(int(os.environ.get('MOCK_SERVE_EXIT','0')))
sys.exit(98)
