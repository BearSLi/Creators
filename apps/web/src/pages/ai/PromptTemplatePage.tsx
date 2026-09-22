import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createAiPrompt, listAiPrompts, updateAiPrompt } from '@/api/ai';
import { resolveErrorMessage } from '@/api/client';
import type { AiPromptTemplate, UpsertAiPromptRequest } from '@/api/types';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { Modal } from '@/components/Modal';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { StatusTag } from '@/components/StatusTag';
import { AUDIT_WRITTEN_HINT, useToast } from '@/components/Toast';
import { formatInteger, formatPercentValue } from '@/utils/format';
import { P } from '@/utils/permissions';

/**
 * Prompt 模板管理。
 *
 * 为什么"编辑"表单里连灰度比例都要给出来：
 *   后端把 prompt 按 key + version 管理，任何一次保存都会产生新版本，
 *   而线上到底用哪个版本由 rolloutPercent 决定。也就是说——只改文案不改灰度，
 *   新版本可能根本没有流量；只调灰度不改文案，又是在调整实验规模。
 *   两者是同一个决策的两半，表单必须放在一起，否则运营会以为"保存了就上线了"。
 *
 * 附带的两个约定：
 *   - rolloutPercent = 0 表示暂停使用该版本（回滚线上问题最快的开关），100 表示全量；
 *   - isActive 是版本级总开关，停用后无论灰度多少都不参与分流。
 */

/** 表单里数字统一用字符串保存：number input 的中间态（如 "0."）无法用 number 表达 */
interface PromptFormValues {
  key: string;
  name: string;
  description: string;
  systemPrompt: string;
  userPromptTemplate: string;
  model: string;
  temperature: string;
  maxTokens: string;
  variables: string;
  isActive: boolean;
  rolloutPercent: string;
}

const EMPTY_FORM: PromptFormValues = {
  key: '',
  name: '',
  description: '',
  systemPrompt: '',
  userPromptTemplate: '',
  model: 'gpt-4o-mini',
  temperature: '0.7',
  maxTokens: '2048',
  variables: '',
  isActive: true,
  rolloutPercent: '100',
};

function toFormValues(template: AiPromptTemplate): PromptFormValues {
  return {
    key: template.key,
    name: template.name,
    description: template.description ?? '',
    systemPrompt: template.systemPrompt,
    userPromptTemplate: template.userPromptTemplate,
    model: template.model,
    temperature: String(template.temperature),
    maxTokens: String(template.maxTokens),
    variables: template.variables.join(', '),
    isActive: template.isActive,
    rolloutPercent: String(template.rolloutPercent),
  };
}

/** 逗号/顿号/空格都当分隔符：运营从文档里粘贴变量名时格式往往不统一 */
function parseVariables(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,，、\s]+/)
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    ),
  ];
}

function validateForm(form: PromptFormValues): string | null {
  if (form.key.trim() === '') return '模板 key 必填：后端按 key 聚合版本，没有 key 无法分流';
  if (form.name.trim() === '') return '模板名称必填，列表与审计日志都用它来标识';
  if (form.systemPrompt.trim() === '') return 'system prompt 必填';
  if (form.userPromptTemplate.trim() === '') return 'user prompt 模板必填';

  const temperature = Number(form.temperature);
  if (Number.isNaN(temperature) || temperature < 0 || temperature > 2) {
    return 'temperature 需要在 0 ~ 2 之间';
  }

  const maxTokens = Number(form.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 32000) {
    return 'maxTokens 需要是 64 ~ 32000 之间的整数';
  }

  const rollout = Number(form.rolloutPercent);
  if (!Number.isInteger(rollout) || rollout < 0 || rollout > 100) {
    return '灰度比例需要是 0 ~ 100 的整数';
  }

  return null;
}

export default function PromptTemplatePage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AiPromptTemplate | null>(null);
  const [form, setForm] = useState<PromptFormValues>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<AiPromptTemplate | null>(null);

  const promptsQuery = useQuery({
    queryKey: ['ai', 'prompts'],
    queryFn: () => listAiPrompts(),
  });

  const saveMutation = useMutation({
    mutationFn: (payload: { id: string | null; body: UpsertAiPromptRequest }) =>
      payload.id === null ? createAiPrompt(payload.body) : updateAiPrompt(payload.id, payload.body),
    onSuccess: (template, payload) => {
      queryClient.invalidateQueries({ queryKey: ['ai', 'prompts'] });
      setFormOpen(false);
      setEditing(null);
      // 把新版本号回显出来：运营需要知道"这次保存产生了 v几"，灰度与回滚都按版本操作
      toast.success(
        `${payload.id === null ? '已创建' : '已更新'}「${template.name}」，当前版本 v${template.version}，${AUDIT_WRITTEN_HINT}`,
      );
    },
  });

  const toggleMutation = useMutation({
    // 启停只是 isActive 的一次 patch，但仍走 updateAiPrompt：后端要在同一事务里写版本与审计
    mutationFn: (template: AiPromptTemplate) =>
      updateAiPrompt(template.id, { isActive: !template.isActive }),
    onSuccess: (template) => {
      queryClient.invalidateQueries({ queryKey: ['ai', 'prompts'] });
      toast.success(
        `「${template.name}」已${template.isActive ? '启用' : '停用'}，${AUDIT_WRITTEN_HINT}`,
      );
    },
  });

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(template: AiPromptTemplate) {
    setEditing(template);
    setForm(toFormValues(template));
    setFormError(null);
    setFormOpen(true);
  }

  function handleSubmit() {
    const message = validateForm(form);
    setFormError(message);
    if (message !== null) return;

    const body: UpsertAiPromptRequest = {
      key: form.key.trim(),
      name: form.name.trim(),
      description: form.description.trim() === '' ? undefined : form.description.trim(),
      systemPrompt: form.systemPrompt.trim(),
      userPromptTemplate: form.userPromptTemplate.trim(),
      variables: parseVariables(form.variables),
      model: form.model.trim() === '' ? undefined : form.model.trim(),
      temperature: Number(form.temperature),
      maxTokens: Number(form.maxTokens),
      isActive: form.isActive,
      rolloutPercent: Number(form.rolloutPercent),
    };

    saveMutation.mutate({ id: editing?.id ?? null, body });
  }

  const prompts = promptsQuery.data ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Prompt 模板"
        subtitle="模板按 key + version 管理，线上流量由灰度比例决定；改动会生成新版本，可随时把灰度调到 0 回滚"
        actions={
          <PermissionGate permission={P.AI_PROMPT_WRITE}>
            <button type="button" className="btn btnPrimary" onClick={openCreate}>
              新建模板
            </button>
          </PermissionGate>
        }
      />

      {promptsQuery.isLoading && (
        <div className="card">
          <div className="cardBody">
            <LoadingSkeleton variant="card" rows={4} />
          </div>
        </div>
      )}

      {promptsQuery.isError && (
        <div className="card">
          <ErrorState
            message={resolveErrorMessage(promptsQuery.error)}
            onRetry={() => {
              void promptsQuery.refetch();
            }}
          />
        </div>
      )}

      {!promptsQuery.isLoading && !promptsQuery.isError && prompts.length === 0 && (
        <div className="card">
          <EmptyState
            title="还没有 Prompt 模板"
            description="模板集中管理后，不同业务线的 AI 产出才能复现与对比；先建一条脚本生成的模板试试。"
            action={
              <PermissionGate permission={P.AI_PROMPT_WRITE}>
                <button type="button" className="btn btnPrimary" onClick={openCreate}>
                  新建模板
                </button>
              </PermissionGate>
            }
          />
        </div>
      )}

      {prompts.length > 0 && (
        <div className="grid gridCols2">
          {prompts.map((template) => (
            <div key={template.id}>
              <div className="card">
                <div className="cardHeader">
                  <div>
                    <div className="cardTitle">{template.name}</div>
                    <div className="hint mono">{template.key}</div>
                  </div>
                  <div className="row">
                    <StatusTag tone={template.isActive ? 'success' : 'neutral'} dot size="sm">
                      {template.isActive ? '启用中' : '已停用'}
                    </StatusTag>
                    <StatusTag tone="info" size="sm">
                      v{template.version}
                    </StatusTag>
                  </div>
                </div>

                <div className="cardBody">
                  <dl className="descriptions">
                    <div className="descriptionsItem">
                      <dt>模型</dt>
                      <dd className="mono">{template.model}</dd>
                    </div>
                    <div className="descriptionsItem">
                      <dt>temperature</dt>
                      <dd className="mono">{template.temperature}</dd>
                    </div>
                    <div className="descriptionsItem">
                      <dt>max tokens</dt>
                      <dd className="mono">{formatInteger(template.maxTokens)}</dd>
                    </div>
                  </dl>

                  <div style={{ marginTop: 'var(--space-3)' }}>
                    <div className="rowBetween">
                      <span className="muted">灰度比例</span>
                      <span className="mono">{formatPercentValue(template.rolloutPercent)}</span>
                    </div>
                    <div
                      style={{
                        height: 6,
                        marginTop: 'var(--space-1)',
                        background: 'var(--color-bg-subtle)',
                        borderRadius: 'var(--radius-pill)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.min(100, Math.max(0, template.rolloutPercent))}%`,
                          height: '100%',
                          background:
                            template.rolloutPercent === 0
                              ? 'var(--color-neutral)'
                              : 'var(--color-primary-600)',
                        }}
                      />
                    </div>
                    <div className="hint">
                      0 表示暂停使用（最快的回滚开关），100 表示全量；中间值按用户维度稳定分流。
                    </div>
                  </div>

                  {template.description && (
                    <div className="muted" style={{ marginTop: 'var(--space-3)' }}>
                      {template.description}
                    </div>
                  )}

                  <div style={{ marginTop: 'var(--space-3)' }}>
                    <div className="sectionTitle">可用变量</div>
                    {template.variables.length === 0 ? (
                      <span className="subtle">未声明变量</span>
                    ) : (
                      <div className="chipGroup">
                        {template.variables.map((variable) => (
                          <span key={variable} className="chip mono">
                            {`{{${variable}}}`}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="divider" />

                  <div className="row wrap">
                    <button
                      type="button"
                      className="btn btnSm"
                      onClick={() => setViewing(template)}
                    >
                      查看 Prompt
                    </button>
                    <PermissionGate permission={P.AI_PROMPT_WRITE}>
                      <button
                        type="button"
                        className="btn btnSm"
                        onClick={() => openEdit(template)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn btnSm"
                        disabled={toggleMutation.isPending}
                        onClick={() => toggleMutation.mutate(template)}
                      >
                        {toggleMutation.isPending && <span className="spinner" aria-hidden="true" />}
                        {template.isActive ? '停用' : '启用'}
                      </button>
                    </PermissionGate>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------------- 查看模板全文 ---------------- */}
      <Modal
        open={viewing !== null}
        title={viewing ? `${viewing.name}（v${viewing.version}）` : ''}
        description={viewing ? `key：${viewing.key} · ${viewing.model}` : undefined}
        size="xl"
        onClose={() => setViewing(null)}
        footer={
          <button type="button" className="btn" onClick={() => setViewing(null)}>
            关闭
          </button>
        }
      >
        {viewing && (
          <div className="stack">
            <div>
              <div className="sectionTitle">System Prompt</div>
              <pre className="codeBlock">{viewing.systemPrompt}</pre>
            </div>
            <div>
              <div className="sectionTitle">User Prompt 模板</div>
              <pre className="codeBlock">{viewing.userPromptTemplate}</pre>
            </div>
            <div>
              <div className="sectionTitle">模板可用变量</div>
              <div className="hint">
                变量在调用时由后端注入（下面列出的名字必须与模板里 {'{{变量名}}'} 完全一致）。
              </div>
              <div className="chipGroup" style={{ marginTop: 'var(--space-2)' }}>
                {viewing.variables.length === 0 ? (
                  <span className="subtle">未声明变量</span>
                ) : (
                  viewing.variables.map((variable) => (
                    <span key={variable} className="chip mono">
                      {`{{${variable}}}`}
                    </span>
                  ))
                )}
              </div>
            </div>
            <div className="hint">
              当前灰度 {formatPercentValue(viewing.rolloutPercent)}，
              {viewing.isActive ? '版本处于启用状态' : '版本已停用（不参与任何分流）'}。
            </div>
          </div>
        )}
      </Modal>

      {/* ---------------- 新建 / 编辑 ---------------- */}
      <Modal
        open={formOpen}
        title={editing === null ? '新建 Prompt 模板' : `编辑「${editing.name}」`}
        description="保存后会生成一个新版本；线上影响范围由灰度比例决定"
        size="xl"
        onClose={() => {
          if (saveMutation.isPending) return;
          setFormOpen(false);
        }}
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={saveMutation.isPending}
              onClick={() => setFormOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btnPrimary"
              disabled={saveMutation.isPending}
              onClick={handleSubmit}
            >
              {saveMutation.isPending && <span className="spinner" aria-hidden="true" />}
              保存
            </button>
          </>
        }
      >
        <div className="formGrid">
          <div className="field">
            <label className="label labelRequired" htmlFor="prompt-key">
              模板 key
            </label>
            <input
              id="prompt-key"
              className="input mono"
              type="text"
              // key 是后端聚合版本的维度，改 key 等于另起一条模板线，因此编辑时锁死
              disabled={editing !== null}
              placeholder="例：script_generate"
              value={form.key}
              onChange={(event) => setForm((prev) => ({ ...prev, key: event.target.value }))}
            />
            <span className="hint">
              {editing === null
                ? '同一业务用途固定用一个 key，便于比较不同版本的效果。'
                : 'key 不可修改：它决定了这条模板的历史版本与灰度流量。'}
            </span>
          </div>

          <div className="field">
            <label className="label labelRequired" htmlFor="prompt-name">
              模板名称
            </label>
            <input
              id="prompt-name"
              className="input"
              type="text"
              placeholder="例：短视频脚本生成（口播版）"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
            />
          </div>

          <div className="field fieldFull">
            <label className="label" htmlFor="prompt-description">
              说明
            </label>
            <input
              id="prompt-description"
              className="input"
              type="text"
              placeholder="这条模板解决什么问题、由谁维护"
              value={form.description}
              onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
            />
          </div>

          <div className="field fieldFull">
            <label className="label labelRequired" htmlFor="prompt-system">
              System Prompt
            </label>
            <textarea
              id="prompt-system"
              className="textarea"
              rows={8}
              placeholder="定义角色、输出格式与硬性约束"
              value={form.systemPrompt}
              onChange={(event) => setForm((prev) => ({ ...prev, systemPrompt: event.target.value }))}
            />
          </div>

          <div className="field fieldFull">
            <label className="label labelRequired" htmlFor="prompt-user">
              User Prompt 模板
            </label>
            <textarea
              id="prompt-user"
              className="textarea"
              rows={8}
              placeholder={'用 {{变量名}} 占位，例：为 {{platform}} 生成 {{duration}} 的口播脚本'}
              value={form.userPromptTemplate}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, userPromptTemplate: event.target.value }))
              }
            />
          </div>

          <div className="field fieldFull">
            <label className="label" htmlFor="prompt-variables">
              变量列表
            </label>
            <input
              id="prompt-variables"
              className="input"
              type="text"
              placeholder="逗号分隔，例：platform, duration, creatorName"
              value={form.variables}
              onChange={(event) => setForm((prev) => ({ ...prev, variables: event.target.value }))}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="prompt-model">
              模型
            </label>
            <input
              id="prompt-model"
              className="input mono"
              type="text"
              placeholder="例：gpt-4o-mini"
              value={form.model}
              onChange={(event) => setForm((prev) => ({ ...prev, model: event.target.value }))}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="prompt-temperature">
              temperature
            </label>
            <input
              id="prompt-temperature"
              className="input mono"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={form.temperature}
              onChange={(event) => setForm((prev) => ({ ...prev, temperature: event.target.value }))}
            />
            <span className="hint">脚本创作建议 0.6 ~ 0.9；合规预检这类判定型任务建议 0 ~ 0.2。</span>
          </div>

          <div className="field">
            <label className="label" htmlFor="prompt-max-tokens">
              max tokens
            </label>
            <input
              id="prompt-max-tokens"
              className="input mono"
              type="number"
              min={64}
              max={32000}
              step={1}
              value={form.maxTokens}
              onChange={(event) => setForm((prev) => ({ ...prev, maxTokens: event.target.value }))}
            />
            <span className="hint">上限越高，单次失败的损失越大（按 token 计费）。</span>
          </div>

          <div className="field">
            <label className="label" htmlFor="prompt-rollout">
              灰度比例（%）
            </label>
            <input
              id="prompt-rollout"
              className="input mono"
              type="number"
              min={0}
              max={100}
              step={1}
              value={form.rolloutPercent}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, rolloutPercent: event.target.value }))
              }
            />
            {/* 这条提示是运营最需要的操作知识：0 与 100 是两个"开关语义"的边界值 */}
            <span className="hint">设为 0 表示暂停使用（新版本先不上流量），100 表示全量。</span>
          </div>

          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <label className="checkboxRow" htmlFor="prompt-active">
              <input
                id="prompt-active"
                type="checkbox"
                checked={form.isActive}
                onChange={(event) => setForm((prev) => ({ ...prev, isActive: event.target.checked }))}
              />
              启用该版本
            </label>
            <span className="hint">停用后无论灰度多少都不参与分流，用于彻底下线。</span>
          </div>

          {formError !== null && <div className="field fieldFull errorText">{formError}</div>}
        </div>
      </Modal>
    </div>
  );
}
