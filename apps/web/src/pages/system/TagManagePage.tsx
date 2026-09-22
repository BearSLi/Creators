import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createTag, deleteTag, listTags, updateTag } from '@/api/tags';
import { resolveErrorMessage } from '@/api/client';
import type { TagItem } from '@/api/types';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { Modal } from '@/components/Modal';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { StatusTag } from '@/components/StatusTag';
import { AUDIT_WRITTEN_HINT, useToast } from '@/components/Toast';
import { TAG_CATEGORY_LABELS, TAG_CATEGORY_OPTIONS } from '@/utils/constants';
import { formatInteger } from '@/utils/format';
import { P } from '@/utils/permissions';

/**
 * 标签维护。
 *
 * 两个刻意的实现选择：
 *   1) **一次拉全量**再在前端按 category 分组：标签是运营手工维护的小数据集（通常 <200 条），
 *      按分类发 5 个请求既慢又多 4 次往返；真到了上千条再改成分页是后话；
 *   2) **删除要显示影响面**：标签是挂在达人身上的（creatorCount），删掉标签等于批量修改 N 位达人，
 *      确认文案必须把 N 说出来，否则用户以为只是删了一个下拉选项。
 */

interface TagFormValues {
  name: string;
  category: string;
  color: string;
}

const DEFAULT_COLOR = '#4f5bd6';

const EMPTY_TAG_FORM: TagFormValues = {
  name: '',
  category: TAG_CATEGORY_OPTIONS[0]?.value ?? 'capability',
  color: DEFAULT_COLOR,
};

export default function TagManagePage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TagItem | null>(null);
  const [form, setForm] = useState<TagFormValues>(EMPTY_TAG_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TagItem | null>(null);

  const tagsQuery = useQuery({
    queryKey: ['tags', 'list'],
    queryFn: () => listTags(),
  });

  const saveMutation = useMutation({
    mutationFn: (payload: { id: string | null; body: TagFormValues }) =>
      payload.id === null
        ? createTag({
            name: payload.body.name,
            category: payload.body.category,
            color: payload.body.color,
          })
        : updateTag(payload.id, {
            name: payload.body.name,
            category: payload.body.category,
            color: payload.body.color,
          }),
    onSuccess: (tag, payload) => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      // 标签被达人列表引用，改动后达人列表的标签筛选也要跟着失效
      queryClient.invalidateQueries({ queryKey: ['creators'] });
      setFormOpen(false);
      setEditing(null);
      toast.success(
        `标签「${tag.name}」已${payload.id === null ? '创建' : '更新'}，${AUDIT_WRITTEN_HINT}`,
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (tag: TagItem) => deleteTag(tag.id),
    onSuccess: (_result, tag) => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      queryClient.invalidateQueries({ queryKey: ['creators'] });
      setDeleteTarget(null);
      toast.success(`标签「${tag.name}」已删除，${AUDIT_WRITTEN_HINT}`);
    },
  });

  function openCreate(category?: string) {
    setEditing(null);
    // 从某个分类里点"新建"时预选该分类：标签的归属分类是高频输入，能少点一次就少点一次
    setForm({ ...EMPTY_TAG_FORM, category: category ?? EMPTY_TAG_FORM.category });
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(tag: TagItem) {
    setEditing(tag);
    setForm({ name: tag.name, category: tag.category, color: tag.color || DEFAULT_COLOR });
    setFormError(null);
    setFormOpen(true);
  }

  function handleSubmit() {
    if (form.name.trim() === '') {
      setFormError('标签名称必填');
      return;
    }
    if (form.category === '') {
      setFormError('请选择标签分类');
      return;
    }
    setFormError(null);
    saveMutation.mutate({
      id: editing?.id ?? null,
      body: { name: form.name.trim(), category: form.category, color: form.color },
    });
  }

  const tags = tagsQuery.data ?? [];
  // 用 readonly string[] 承接：后端 category 是自由文本，可能出现前端常量表里没有的分类
  const knownCategories: readonly string[] = TAG_CATEGORY_OPTIONS.map((option) => option.value);
  // 后端可能新增了常量表里还没有的分类：不能因为前端没登记就"查不到这些标签"，兜底单独成组
  const unknownCategories = [...new Set(tags.map((tag) => tag.category))].filter(
    (category) => !knownCategories.includes(category),
  );
  const groups = [
    ...TAG_CATEGORY_OPTIONS.map((option) => ({
      value: option.value as string,
      label: TAG_CATEGORY_LABELS[option.value],
    })),
    ...unknownCategories.map((value) => ({ value, label: value })),
  ];

  return (
    <div className="page">
      <PageHeader
        title="标签管理"
        subtitle="标签用于达人筛选与批量运营；删除标签会同时从所有关联达人身上移除"
        actions={
          <PermissionGate permission={P.CREATOR_WRITE}>
            <button type="button" className="btn btnPrimary" onClick={() => openCreate()}>
              新建标签
            </button>
          </PermissionGate>
        }
      />

      {tagsQuery.isLoading && (
        <div className="card">
          <div className="cardBody">
            <LoadingSkeleton variant="card" rows={3} />
          </div>
        </div>
      )}

      {tagsQuery.isError && (
        <div className="card">
          <ErrorState
            message={resolveErrorMessage(tagsQuery.error)}
            onRetry={() => {
              void tagsQuery.refetch();
            }}
          />
        </div>
      )}

      {tagsQuery.data && tags.length === 0 && (
        <div className="card">
          <EmptyState
            title="还没有任何标签"
            description="标签是达人池运营的基础：先按风格/场景建立几个常用标签，后续筛选与批量派单都会用到。"
            action={
              <PermissionGate permission={P.CREATOR_WRITE}>
                <button type="button" className="btn btnPrimary" onClick={() => openCreate()}>
                  新建标签
                </button>
              </PermissionGate>
            }
          />
        </div>
      )}

      {tags.length > 0 && (
        <div className="grid gridCols2">
          {groups.map((group) => {
            const groupTags = tags.filter((tag) => tag.category === group.value);
            return (
              <div key={group.value}>
                <div className="card">
                  <div className="cardHeader">
                    <span className="cardTitle">{group.label}</span>
                    <div className="row">
                      <span className="hint">{groupTags.length} 个标签</span>
                      <PermissionGate permission={P.CREATOR_WRITE}>
                        <button
                          type="button"
                          className="btn btnSm"
                          onClick={() => openCreate(group.value)}
                        >
                          新建
                        </button>
                      </PermissionGate>
                    </div>
                  </div>
                  <div className="cardBody">
                    {groupTags.length === 0 ? (
                      <div className="emptyInline">该分类下还没有标签</div>
                    ) : (
                      groupTags.map((tag) => (
                        <div
                          key={tag.id}
                          className="rowBetween"
                          style={{
                            padding: 'var(--space-2) 0',
                            borderBottom: '1px solid var(--color-border)',
                          }}
                        >
                          <div className="row" style={{ gap: 'var(--space-2)' }}>
                            {/* 颜色由后端下发，StatusTag 用 color-mix 派生浅底，保证深浅色都可读 */}
                            <StatusTag color={tag.color} dot>
                              {tag.name}
                            </StatusTag>
                            <span className="hint">{formatInteger(tag.creatorCount)} 位达人</span>
                          </div>
                          <div className="tableActions">
                            <PermissionGate permission={P.CREATOR_WRITE}>
                              <button type="button" className="btnLink" onClick={() => openEdit(tag)}>
                                编辑
                              </button>
                              <button
                                type="button"
                                className="btnLink btnLinkDanger"
                                onClick={() => setDeleteTarget(tag)}
                              >
                                删除
                              </button>
                            </PermissionGate>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ---------------- 新建 / 编辑标签 ---------------- */}
      <Modal
        open={formOpen}
        title={editing === null ? '新建标签' : `编辑标签「${editing.name}」`}
        size="sm"
        onClose={() => {
          if (saveMutation.isPending) return;
          setFormOpen(false);
          setEditing(null);
        }}
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={saveMutation.isPending}
              onClick={() => {
                setFormOpen(false);
                setEditing(null);
              }}
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
        <div className="stack">
          <div className="field">
            <label className="label labelRequired" htmlFor="tag-name">
              标签名称
            </label>
            <input
              id="tag-name"
              className="input"
              type="text"
              placeholder="例：口播型、价格敏感、需提前 15 天预约"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
            />
            <span className="hint">名称会直接显示在达人列表的标签位上，尽量控制在 8 个字以内。</span>
          </div>

          <div className="field">
            <label className="label labelRequired" htmlFor="tag-category">
              分类
            </label>
            <select
              id="tag-category"
              className="select"
              value={form.category}
              onChange={(event) => setForm((prev) => ({ ...prev, category: event.target.value }))}
            >
              {TAG_CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="hint">分类决定了标签在筛选器里的归组，创建后也可以调整。</span>
          </div>

          <div className="field">
            <label className="label" htmlFor="tag-color">
              标签颜色
            </label>
            <div className="row">
              <input
                id="tag-color"
                type="color"
                style={{
                  width: 48,
                  height: 32,
                  padding: 2,
                  border: '1px solid var(--color-border-strong)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-bg-surface)',
                  cursor: 'pointer',
                }}
                value={form.color}
                onChange={(event) => setForm((prev) => ({ ...prev, color: event.target.value }))}
              />
              <StatusTag color={form.color} dot>
                {form.name.trim() === '' ? '效果预览' : form.name.trim()}
              </StatusTag>
              <span className="mono subtle">{form.color}</span>
            </div>
            <span className="hint">建议同一分类用相近色系，列表里靠颜色区分语义比读文字更快。</span>
          </div>

          {formError !== null && <div className="errorText">{formError}</div>}
        </div>
      </Modal>

      {/* ---------------- 删除确认 ---------------- */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除标签"
        danger
        confirmText="删除"
        loading={deleteMutation.isPending}
        message={
          <>
            将删除标签 <StatusTag color={deleteTarget?.color ?? DEFAULT_COLOR}>{deleteTarget?.name}</StatusTag>
            ，并<strong>从 {formatInteger(deleteTarget?.creatorCount ?? 0)} 位达人身上移除该标签</strong>。
            该操作会写入审计日志，但标签本身无法恢复，请确认没有正在跑的筛选视图依赖它。
          </>
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget);
        }}
      />
    </div>
  );
}
