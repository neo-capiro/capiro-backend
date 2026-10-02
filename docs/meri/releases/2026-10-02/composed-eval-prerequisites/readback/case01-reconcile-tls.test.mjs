import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import { createServer, connect, checkServerIdentity, createSecureContext } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const source=readFileSync(join(root,'case01-reconcile-readonly-v2.mjs'),'utf8');
const block=source.split('// BEGIN FIXED RDS TLS OPTIONS')[1].split('\n').slice(1).join('\n').split('// END FIXED RDS TLS OPTIONS')[0];
const factory=new Function('assert','createHash','checkServerIdentity',block+'\nreturn {rdsTlsOptions,RDS_CA_SHA256,RDS_CA_PEM};')(assert,createHash,checkServerIdentity);
const host='case01-owned.abcdefg.us-east-1.rds.amazonaws.com';
const url=`postgresql://owned:synthetic@${host}:5432/unused?schema=public&sslmode=require&connection_limit=10`;
const require=createRequire('C:/dev/cap-meri-approval-recovery/apps/api/package.json');
const {Client}=require('pg');
it('actual pinned RDS bundle contains three currently valid self-signed CA roots and loads as native TLS trust',()=>{
  const actual=readFileSync(join(root,'rds-us-east-1-bundle.pem'));
  assert.equal(createHash('sha256').update(actual).digest('hex'),factory.RDS_CA_SHA256);
  assert.equal(factory.RDS_CA_PEM,actual.toString());
  const certs=factory.RDS_CA_PEM.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  assert.equal(certs.length,3);
  for(const pem of certs){const cert=new X509Certificate(pem);assert.equal(cert.ca,true);assert.equal(cert.subject,cert.issuer);assert.equal(cert.verify(cert.publicKey),true);assert.ok(Date.parse(cert.validFrom)<Date.now());assert.ok(Date.parse(cert.validTo)>Date.now());assert.match(cert.subject,/Amazon RDS us-east-1 Root CA/u);}
  assert.ok(createSecureContext({ca:factory.RDS_CA_PEM}));
});
it('actual pg Client preserves explicit CA, verification and hostname when composer sslmode is removed',()=>{
  const options=factory.rdsTlsOptions(url), client=new Client(options);
  assert.equal(new URL(options.connectionString).searchParams.has('sslmode'),false);
  assert.equal(client.connectionParameters.host,host);
  assert.equal(client.connectionParameters.ssl.ca,factory.RDS_CA_PEM);
  assert.equal(client.connectionParameters.ssl.rejectUnauthorized,true);
  assert.equal(client.connectionParameters.ssl.servername,host);
  assert.equal(typeof client.connectionParameters.ssl.checkServerIdentity,'function');
  for(const candidate of [url.replace('sslmode=require','sslmode=disable'),url+'&sslmode=require',url+'&sslrootcert=/untrusted',url.replace(host,'attacker.invalid')])assert.throws(()=>factory.rdsTlsOptions(candidate));
});
it('real loopback TLS verifies chain and hostname; wrong CA and wrong hostname are refused',async()=>{
  const temp=mkdtempSync(join(root,'owned-tls-test-'));
  assert.equal(dirname(resolve(temp)),resolve(root));
  const openssl='C:/Program Files/Git/usr/bin/openssl.exe';
  const run=args=>execFileSync(openssl,args,{cwd:temp,stdio:'pipe',windowsHide:true});
  let server;
  try{
    run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=Owned loopback test CA','-addext','basicConstraints=critical,CA:TRUE']);
    run(['req','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-out','leaf.csr','-subj','/CN='+host]);
    writeFileSync(join(temp,'leaf.ext'),'subjectAltName=DNS:'+host+'\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
    run(['x509','-req','-in','leaf.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','leaf.pem','-days','1','-extfile','leaf.ext']);
    const ca=readFileSync(join(temp,'ca.pem'));
    server=createServer({key:readFileSync(join(temp,'leaf.key')),cert:readFileSync(join(temp,'leaf.pem'))},socket=>socket.end());
    server.on('tlsClientError',()=>{});
    await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});
    const attempt=ssl=>new Promise((res,rej)=>{const socket=connect({host:'127.0.0.1',port:server.address().port,...ssl});socket.setTimeout(5000,()=>socket.destroy(new Error('owned timeout')));socket.once('secureConnect',()=>{const authorized=socket.authorized;socket.end();res(authorized);});socket.once('error',rej);});
    const options=new Client(factory.rdsTlsOptions(url)).connectionParameters.ssl;
    assert.equal(await attempt({...options,ca}),true);
    await assert.rejects(attempt(options),error=>['UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code));
    const wrong=new Client(factory.rdsTlsOptions(url.replace(host,'other.abcdefg.us-east-1.rds.amazonaws.com'))).connectionParameters.ssl;
    await assert.rejects(attempt({...wrong,ca}),error=>error.code==='ERR_TLS_CERT_ALTNAME_INVALID');
  }finally{if(server)await new Promise(resolve=>server.close(resolve));assert.equal(dirname(resolve(temp)),resolve(root));rmSync(temp,{recursive:true,force:false});}
});
