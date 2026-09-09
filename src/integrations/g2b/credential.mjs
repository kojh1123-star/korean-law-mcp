import { execFileSync } from 'node:child_process';
import path from 'node:path';
export const VARIABLES={default:'나라장터',bids:'나라장터',awards:'나라장터',contracts:'나라장터'};
export function normalizeKey(value) {
 const key=String(value??'').trim();
 if(!/%[a-f0-9]{2}/i.test(key))return key;
 try{return decodeURIComponent(key);}catch{throw new Error('나라장터 인증키의 URL 인코딩 형식이 잘못되었습니다.');}
}
export function readCredentials() {
 let registered={};
 if(process.platform==='win32') {
   // Encoded variable NAMES only. Keys are captured privately into process memory.
   const names=Buffer.from(JSON.stringify([VARIABLES.default]),'utf8').toString('base64');
   const script=`$names=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${names}'))|ConvertFrom-Json; $values=@{}; foreach($n in $names){foreach($s in @('User','Machine','Process')){$k=[Environment]::GetEnvironmentVariable($n,$s); if(-not [string]::IsNullOrWhiteSpace($k)){$values[$n]=$k.Trim();break}}}; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $values|ConvertTo-Json -Compress`;
   try{registered=JSON.parse(execFileSync(path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:8000,maxBuffer:32768,stdio:['ignore','pipe','pipe']}));}catch{}
 }
 return selectCredentials(registered,process.env);
}
export function selectCredentials(registered={},env={}) {
 const common=registered[VARIABLES.default]??env[VARIABLES.default]??env.G2B_API_KEY??'';
 const keys={};const sources={};
 for(const service of ['bids','awards','contracts']) {
   keys[service]=normalizeKey(common);
   sources[service]=VARIABLES.default;
 }
 return {keys,sources};
}
