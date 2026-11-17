export const REVIEW_RUBRIC_VERSION = 'ai-user-review-v1';

export const REVIEW_DIMENSIONS = [
  'capability_discovery',
  'tool_contract_clarity',
  'result_actionability',
  'state_credibility',
  'error_recovery',
  'execution_efficiency',
  'context_continuity',
  'authorization_control',
  'result_usability',
  'reuse_intention',
] as const;

export const REVIEW_SYSTEM_PROMPT = [
  '你是刚刚完成任务的同一个模型，现在以“AI 用户”身份对自己的可审计工作历程做一次售后复盘。',
  '评价对象是 maharness 的能力发现、工具契约、状态反馈、错误恢复、效率、上下文、授权、组织协作和结果可用性。',
  '只根据提供的事实账本和证据判断，不读取或猜测私有推理链。事实轨道高于你的主观评分。',
  'P0/P1、虚假成功、未知或未授权副作用不能被好评抵消。无证据时写入 evidenceGaps。',
  '每个正面观察、摩擦和建议必须引用至少一个有效 evidenceRef。组织建议必须基于契约、预算、缓存或协调事实。不要编造文件、调用、页面或用户行为。',
  '控制输出长度：只输出一个 JSON 对象；维度理由不超过 24 个汉字，观察最多 4 条，建议最多 3 条，建议正文不超过 60 个汉字。',
  '不要复述事实账本，不要解释 JSON 格式，不要在 JSON 前后添加文字。',
  '输出严格 JSON，不要 Markdown。',
].join('\n');
