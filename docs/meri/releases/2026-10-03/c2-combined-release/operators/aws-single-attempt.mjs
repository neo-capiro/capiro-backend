import {execFileSync} from 'node:child_process';

// Use for attended mutation paths. The AWS CLI itself must not retry a request
// before the caller records/reconciles its outcome.
export function awsSingleAttempt(args) {
  try {
    return JSON.parse(execFileSync('C:/Program Files/Amazon/AWSCLIV2/aws.exe',[
      ...args,'--profile','capiro-dev','--region','us-east-1','--output','json','--no-cli-pager',
    ],{
      encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],
      maxBuffer:8*1024*1024,timeout:90000,
      env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',
        PYTHONIOENCODING:'utf8',PYTHONUTF8:'1',AWS_CLI_OUTPUT_ENCODING:'UTF8'},
    }));
  } catch {throw new Error('AWS_SINGLE_ATTEMPT_FAILED_'+args.slice(0,2).join('_'));}
}
