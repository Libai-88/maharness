import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createToolCatalog } from '../kernel/tool-discovery';
import { estimateTokens } from '../kernel/tokens';
import type { ToolDef } from '../kernel/types';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = '5a10210e8e0b64898a1b9d560c18e528a33d8be8';
const source = execFileSync('git', ['show', `${baseline}:web-agent/kernel/tool-discovery.ts`], { cwd: root, encoding: 'utf8' });
const tree = ts.createSourceFile('baseline.ts', source, ts.ScriptTarget.Latest, true);
function literal(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(item => literal(item as ts.Expression));
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.filter(ts.isPropertyAssignment).map(item => [item.name.getText(tree).replace(/^['"]|['"]$/g, ''), literal(item.initializer)]));
  throw new Error(`Unsupported fixture literal: ${node.getText(tree).slice(0, 80)}`);
}
const managers: { name: string; description: string; parameters: unknown }[] = [];
const visit = (node: ts.Node): void => {
  if (ts.isObjectLiteralExpression(node)) {
    const properties = node.properties.filter(ts.isPropertyAssignment);
    const name = properties.find(item => item.name.getText(tree) === 'name')?.initializer;
    if (name && ts.isStringLiteral(name) && ['discover_tools','enable_tools','release_tools'].includes(name.text)) {
      const get = (key: string) => literal(properties.find(item => item.name.getText(tree) === key)!.initializer);
      managers.push({ name: name.text, description: String(get('description')), parameters: get('parameters') });
    }
  }
  ts.forEachChild(node, visit);
};
visit(tree);
if (managers.length !== 3) throw new Error('Baseline catalog fixture could not be read');
const schema = (tools: Pick<ToolDef, 'name'|'description'|'parameters'>[]) => tools.map(({name,description,parameters}) => ({name,description,parameters}));
const catalogs = [1,4,12].map(count => {
  const tools: ToolDef[] = Array.from({length:count}, (_,i)=>({name:`lookup_${i}`,description:'Read an authorized record by its identifier.',version:'2.0.0',permissions:['workspace.read'],sideEffect:'read',parameters:{type:'object',properties:{id:{type:'string'}},required:['id']},outputSchema:{type:'object'},handler:async()=>({ok:true,data:{}})}));
  const before = estimateTokens(JSON.stringify([...schema(tools),...managers]));
  const after = estimateTokens(JSON.stringify(schema(createToolCatalog(tools))));
  return {tools:count,baselineEstimatedTokens:before,candidateEstimatedTokens:after,savedEstimatedTokens:before-after,directToolsReachable:createToolCatalog(tools).length===count};
});
const files = [
  'kernel/tests/tool-discovery.spec.ts', 'kernel/tests/plugin-review.spec.ts', 'kernel/tests/process-plugin.spec.ts',
  'core/self-extend/tests/task-plugins.spec.ts', 'core/chat/tests/optimization-contracts.spec.ts',
  'core/chat/tests/tool-broker.spec.ts', 'core/chat/tests/retry-policy.spec.ts',
  'core/powershell/tests/processes.spec.ts', 'core/powershell/tests/cancellation.spec.ts',
  'server/tests/run-service.spec.ts',
  'server/tests/run-composition.spec.ts',
];
const result = spawnSync(process.execPath, ['--import','tsx','--test','--test-concurrency=2',...files], {cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,timeout:180_000});
const output = result.stdout + result.stderr;
const count = (label:string) => Number(new RegExp(`^# ${label} (\\d+)`, 'm').exec(output)?.[1] ?? 0);
const paths = execFileSync('git',['ls-files','-z','kernel','core','server','scripts','ui/src'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const untracked = execFileSync('git',['ls-files','--others','--exclude-standard','-z','kernel','core','server','scripts','ui/src'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const hash = createHash('sha256');
for (const path of [...new Set([...paths,...untracked])].sort()) hash.update(path).update('\0').update(readFileSync(resolve(root,path))).update('\0');
const passed = result.status===0 && count('tests')>0 && count('fail')===0 && catalogs.every(item=>item.directToolsReachable && item.savedEstimatedTokens>0);
const report = {kind:'targeted-deterministic-optimization',createdAt:new Date().toISOString(),baselineRevision:baseline,head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),workingSourceSha256:hash.digest('hex'),passed,tests:{total:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped'),exitCode:result.status},catalogs,modelRequests:0,files,limitations:['Catalog measurements are local estimates for fixed synthetic catalogs, not task-level token usage.','Deterministic execution does not measure autonomous model success or supplier protocol compatibility.','This suite does not replace release performance gates.']};
const reportIndex=process.argv.indexOf('--report');
if(reportIndex>=0){if(!process.argv[reportIndex+1])throw new Error('--report requires a path');const path=resolve(process.argv[reportIndex+1]);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify(report,null,2));
if(!passed){console.error(output);if(result.error)console.error(result.error.message);process.exitCode=1;}
