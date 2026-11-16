import { test, expect } from '@playwright/test';
test('personal items persist, edit scheduling and reflect in the shared workbench',async({page,request})=>{
  const title=`事项-${Date.now()}`;
  await page.goto('/todo.html');await expect(page.getByRole('button',{name:'添加',exact:true})).toBeDisabled();
  await page.getByLabel('新增个人事项').fill(title);await page.getByRole('button',{name:'添加',exact:true}).click();
  const card=page.getByTestId('personal-item').filter({hasText:title});await expect(card).toContainText('未排期');
  await card.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('说明',{exact:true}).fill('需要核对原始数据');await page.getByLabel('日期',{exact:true}).fill('2026-12-10');await page.getByLabel('时间（可选）').fill('10:30');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(card).toContainText('2026-12-10');
  await page.reload();await expect(card).toContainText('10:30');
  const response=await request.get('/api/plugins/workbench/wb/data');expect(response.ok()).toBeTruthy();const snapshot=await response.json();const item=snapshot.data.tasks.find((item:{title:string})=>item.title===title);expect(item.note).toBe('需要核对原始数据');
  item.title=title+'-已更新';expect((await request.put('/api/plugins/workbench/wb/data',{data:snapshot})).ok()).toBeTruthy();
  await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByTestId('personal-item').filter({hasText:title+'-已更新'})).toBeVisible();
  await page.goto(`/todo.html?item=${encodeURIComponent(item.id)}`);await expect(page.getByRole('dialog')).toContainText('需要核对原始数据');
});
test('editing conflict keeps the draft and the server version',async({page,request})=>{
  const title=`冲突-${Date.now()}`;const created=await (await request.post('/api/items',{data:{title}})).json();
  await page.goto('/todo.html');const card=page.getByTestId('personal-item').filter({hasText:title});await card.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('说明',{exact:true}).fill('页面草稿');
  expect((await request.patch(`/api/items/${created.item.id}`,{data:{revision:created.item.revision,note:'服务端版本'}})).ok()).toBeTruthy();
  await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByText('事项已变化，请重新读取后修改',{exact:false})).toBeVisible();await expect(page.getByLabel('说明',{exact:true})).toHaveValue('页面草稿');
  expect((await (await request.get(`/api/items/${created.item.id}`)).json()).item.note).toBe('服务端版本');
});
test('workbench overview retains full projects, notes and backups with shared persistence',async({page,request})=>{
  await page.goto('/todo.html?view=overview');await expect(page.getByRole('heading',{name:'今日及逾期事项'})).toBeVisible();await page.getByRole('button',{name:'完整工作台'}).click();
  await page.getByRole('button',{name:'项目',exact:true}).click();await page.getByRole('button',{name:'新建项目',exact:true}).click();const title=`项目-${Date.now()}`;await page.getByLabel('项目名称',{exact:true}).fill(title);await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect.poll(async()=>{const snapshot=await(await request.get('/api/plugins/workbench/wb/data')).json();return snapshot.data.projects.some((project:{name:string})=>project.name===title);}).toBeTruthy();
  await page.reload();await page.getByRole('button',{name:'项目',exact:true}).click();await expect(page.getByText(title,{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'数据与备份',exact:true}).click();await expect(page.getByRole('button',{name:'导出 JSON',exact:true})).toBeVisible();await expect(page.getByText('应用存储',{exact:true}).first()).toBeVisible();
});
test('iframe source conversation returns to the host chat',async({page,request})=>{
  const source=await (await request.post('/api/sessions',{data:{model:''}})).json();
  const created=await(await request.post('/api/items',{data:{title:`来源-${Date.now()}`}})).json();
  // A source link is supplied by the trusted tool context, represented here by the API fixture.
  await page.route(`**/api/items/${created.item.id}`,route=>route.fulfill({json:{item:{...created.item,sourceSessionId:source.id},attempts:[]}}));
  await page.route('**/api/items',async route=>{const response=await route.fetch();const data=await response.json();data.items=data.items.map((item:{id:string})=>item.id===created.item.id?{...item,sourceSessionId:source.id}:item);await route.fulfill({json:data});});
  await page.goto(`/todo.html?item=${encodeURIComponent(created.item.id)}`);await page.getByRole('button',{name:'来源会话',exact:true}).click();await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();await expect(page).toHaveURL(new RegExp(`session=${encodeURIComponent(source.id)}`));
});
