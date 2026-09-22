import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createBrand, deleteBrand, listBrands, updateBrand } from '@/api/brands';
import { resolveErrorMessage } from '@/api/client';
import type { BrandLevel, BrandListItem, UpsertBrandRequest } from '@/api/types';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar } from '@/components/FilterBar';
import { Modal } from '@/components/Modal';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { StatusTag, type StatusTone } from '@/components/StatusTag';
import { AUDIT_WRITTEN_HINT, useToast } from '@/components/Toast';
import { useTableQuery } from '@/hooks/useTableQuery';
import { BRAND_LEVEL_OPTIONS, PHONE_PATTERN } from '@/utils/constants';
import { formatDateTime, formatInteger } from '@/utils/format';
import { P } from '@/utils/permissions';

/**
 * 品牌（客户方）。
 *
 * 两条业务约束：
 *   1) **联系人电话是商务资源**：品牌的联系人往往是 BD 花很久才谈下来的对接人，
 *      属于团队的核心商业资产，只对有写权限（brand:write）的人展示明文，其余人看到锁标识；
 *   2) **付款账期直接决定结算单的到期日**：paymentTermDays 填错会让整条结算链路的时间线错位，
 *      因此做成 0~365 的整数强校验，而不是放任自由输入。
 */

type BrandFilters = {
  keyword: string;
  level: string;
};

interface BrandFormValues {
  name: string;
  industry: string;
  contactName: string;
  contactPhone: string;
  level: BrandLevel;
  paymentTermDays: string;
  invoiceTitle: string;
  taxNo: string;
  remark: string;
}

const EMPTY_BRAND_FORM: BrandFormValues = {
  name: '',
  industry: '',
  contactName: '',
  contactPhone: '',
  level: 'B',
  paymentTermDays: '30',
  invoiceTitle: '',
  taxNo: '',
  remark: '',
};

/** S 级是战略客户，用最强的红色提醒"这单不能出错"；B/C 是常规与长尾，保持中性 */
const BRAND_LEVEL_TONES: Record<string, StatusTone> = {
  S: 'danger',
  A: 'warning',
  B: 'neutral',
  C: 'neutral',
};

function validateBrandForm(form: BrandFormValues): string | null {
  if (form.name.trim() === '') return '品牌名称必填';
  if (form.contactPhone.trim() !== '' && !PHONE_PATTERN.test(form.contactPhone.trim())) {
    return '联系电话格式不正确（需为 11 位大陆手机号）';
  }
  const term = Number(form.paymentTermDays);
  if (!Number.isInteger(term) || term < 0 || term > 365) {
    return '付款账期需要是 0 ~ 365 之间的整数（天）';
  }
  return null;
}

export default function BrandListPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BrandListItem | null>(null);
  const [form, setForm] = useState<BrandFormValues>(EMPTY_BRAND_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BrandListItem | null>(null);
  // FilterBar 的关键词框是非受控 + 防抖实现，重置筛选时靠重挂载清掉输入框里的残留文本
  const [filterResetKey, setFilterResetKey] = useState(0);

  const table = useTableQuery<BrandFilters>({
    initialFilters: { keyword: '', level: '' },
    initialPageSize: 20,
    initialSort: { sortBy: 'createdAt', sortOrder: 'desc' },
  });
  const filters = table.filters;

  const listQuery = useQuery({
    queryKey: ['brands', 'list', table.query],
    queryFn: () =>
      listBrands({
        page: table.query.page,
        pageSize: table.query.pageSize,
        sortBy: table.query.sortBy,
        sortOrder: table.query.sortOrder,
        keyword: filters.keyword,
        // select 未选择时是空串，空串会被 buildParams 丢掉，避免命中后端枚举校验
        level: filters.level === '' ? undefined : (filters.level as BrandLevel),
      }),
    placeholderData: keepPreviousData,
  });

  const saveMutation = useMutation({
    mutationFn: (payload: { id: string | null; body: UpsertBrandRequest }) =>
      payload.id === null ? createBrand(payload.body) : updateBrand(payload.id, payload.body),
    onSuccess: (brand, payload) => {
      queryClient.invalidateQueries({ queryKey: ['brands'] });
      // 合同列表与项目列表都会展示品牌名，品牌改名后这些缓存必须失效
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setFormOpen(false);
      setEditing(null);
      toast.success(
        `品牌「${brand.name}」已${payload.id === null ? '创建' : '更新'}，${AUDIT_WRITTEN_HINT}`,
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (brand: BrandListItem) => deleteBrand(brand.id),
    onSuccess: (_result, brand) => {
      queryClient.invalidateQueries({ queryKey: ['brands'] });
      setDeleteTarget(null);
      toast.success(`品牌「${brand.name}」已删除，${AUDIT_WRITTEN_HINT}`);
    },
  });

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_BRAND_FORM);
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(brand: BrandListItem) {
    setEditing(brand);
    setForm({
      name: brand.name,
      industry: brand.industry ?? '',
      contactName: brand.contactName ?? '',
      contactPhone: brand.contactPhone ?? '',
      level: brand.level,
      paymentTermDays: String(brand.paymentTermDays),
      invoiceTitle: brand.invoiceTitle ?? '',
      taxNo: brand.taxNo ?? '',
      remark: brand.remark ?? '',
    });
    setFormError(null);
    setFormOpen(true);
  }

  function handleSubmit() {
    const message = validateBrandForm(form);
    setFormError(message);
    if (message !== null) return;

    const body: UpsertBrandRequest = {
      name: form.name.trim(),
      industry: form.industry.trim() === '' ? undefined : form.industry.trim(),
      contactName: form.contactName.trim() === '' ? undefined : form.contactName.trim(),
      contactPhone: form.contactPhone.trim() === '' ? undefined : form.contactPhone.trim(),
      level: form.level,
      paymentTermDays: Number(form.paymentTermDays),
      invoiceTitle: form.invoiceTitle.trim() === '' ? undefined : form.invoiceTitle.trim(),
      taxNo: form.taxNo.trim() === '' ? undefined : form.taxNo.trim(),
      remark: form.remark.trim() === '' ? undefined : form.remark.trim(),
    };

    saveMutation.mutate({ id: editing?.id ?? null, body });
  }

  const columns: Array<Column<BrandListItem>> = [
    { key: 'name', title: '品牌名称', render: (row) => row.name },
    {
      key: 'industry',
      title: '行业',
      render: (row) => row.industry ?? <span className="subtle">—</span>,
    },
    {
      key: 'level',
      title: '等级',
      render: (row) => (
        <StatusTag tone={BRAND_LEVEL_TONES[row.level] ?? 'neutral'} size="sm">
          {row.level}
        </StatusTag>
      ),
    },
    {
      key: 'contactName',
      title: '联系人',
      render: (row) => row.contactName ?? <span className="subtle">—</span>,
    },
    {
      key: 'contactPhone',
      title: '联系电话',
      // 商业资源：无写权限的人只看得到"已脱敏"，而不是整列消失（消失会让人以为没填）
      render: (row) =>
        row.contactPhone ? (
          <PermissionGate permission={P.BRAND_WRITE} fallback="lock" lockText="已脱敏">
            <span className="mono">{row.contactPhone}</span>
          </PermissionGate>
        ) : (
          <span className="subtle">—</span>
        ),
    },
    {
      key: 'paymentTermDays',
      title: '付款账期',
      align: 'right',
      render: (row) => `${formatInteger(row.paymentTermDays)} 天`,
    },
    {
      key: 'invoiceTitle',
      title: '发票抬头',
      render: (row) => row.invoiceTitle ?? <span className="subtle">—</span>,
    },
    {
      key: 'taxNo',
      title: '税号',
      render: (row) =>
        row.taxNo ? <span className="mono">{row.taxNo}</span> : <span className="subtle">—</span>,
    },
    {
      key: 'contractCount',
      title: '关联合同',
      align: 'right',
      render: (row) => formatInteger(row.contractCount),
    },
    {
      key: 'createdAt',
      title: '创建时间',
      sortable: true,
      render: (row) => formatDateTime(row.createdAt),
    },
    {
      key: 'actions',
      title: '操作',
      render: (row) => (
        <div className="tableActions">
          <PermissionGate permission={P.BRAND_WRITE}>
            <button type="button" className="btnLink" onClick={() => openEdit(row)}>
              编辑
            </button>
            <button
              type="button"
              className="btnLink btnLinkDanger"
              onClick={() => setDeleteTarget(row)}
            >
              删除
            </button>
          </PermissionGate>
        </div>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="品牌管理"
        subtitle="品牌是合同与结算的客户方；付款账期直接决定结算单到期日，请与商务合同保持一致"
        actions={
          <PermissionGate permission={P.BRAND_WRITE}>
            <button type="button" className="btn btnPrimary" onClick={openCreate}>
              新建品牌
            </button>
          </PermissionGate>
        }
      />

      <FilterBar
        key={filterResetKey}
        fields={[
          {
            type: 'keyword',
            key: 'keyword',
            value: filters.keyword,
            placeholder: '品牌名称 / 联系人',
            onChange: (value) => table.setFilters({ keyword: value }),
          },
          {
            type: 'select',
            key: 'level',
            label: '品牌等级',
            value: filters.level,
            options: BRAND_LEVEL_OPTIONS,
            onChange: (value) => table.setFilters({ level: value }),
          },
        ]}
        onReset={() => {
          table.reset();
          setFilterResetKey((prev) => prev + 1);
        }}
        resultCount={listQuery.data?.total}
      />

      <DataTable<BrandListItem>
        columns={columns}
        rows={listQuery.data?.items ?? []}
        rowKey={(row) => row.id}
        loading={listQuery.isLoading}
        error={listQuery.isError ? resolveErrorMessage(listQuery.error) : null}
        onRetry={() => {
          void listQuery.refetch();
        }}
        onSortChange={table.setSort}
        sortBy={table.query.sortBy}
        sortOrder={table.query.sortOrder}
        page={table.query.page}
        pageSize={table.query.pageSize}
        total={listQuery.data?.total}
        totalPages={listQuery.data?.totalPages}
        onPageChange={table.setPage}
        onPageSizeChange={table.setPageSize}
        pageSizeOptions={table.pageSizeOptions}
        emptyTitle="没有符合条件的品牌"
        emptyDescription="关键词会同时匹配品牌名称与联系人；也可以清空等级筛选后重试"
        stickyHeader
      />

      {/* ---------------- 新建 / 编辑品牌 ---------------- */}
      <Modal
        open={formOpen}
        title={editing === null ? '新建品牌' : `编辑品牌「${editing.name}」`}
        description="发票抬头与税号会打印在结算单上，请照营业执照填写"
        size="lg"
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
        <div className="formGrid">
          <div className="field">
            <label className="label labelRequired" htmlFor="brand-name">
              品牌名称
            </label>
            <input
              id="brand-name"
              className="input"
              type="text"
              placeholder="填写营业执照上的品牌/公司名"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="brand-industry">
              行业
            </label>
            <input
              id="brand-industry"
              className="input"
              type="text"
              placeholder="例：美妆个护、3C 数码"
              value={form.industry}
              onChange={(event) => setForm((prev) => ({ ...prev, industry: event.target.value }))}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="brand-contact-name">
              联系人
            </label>
            <input
              id="brand-contact-name"
              className="input"
              type="text"
              value={form.contactName}
              onChange={(event) => setForm((prev) => ({ ...prev, contactName: event.target.value }))}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="brand-contact-phone">
              联系电话
            </label>
            <input
              id="brand-contact-phone"
              className={`input ${form.contactPhone !== '' && !PHONE_PATTERN.test(form.contactPhone) ? 'inputError' : ''}`}
              type="text"
              placeholder="11 位手机号"
              value={form.contactPhone}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, contactPhone: event.target.value }))
              }
            />
            <span className="hint">
              仅对拥有品牌维护权限的同事可见，其他人在列表里只能看到「已脱敏」。
            </span>
          </div>

          <div className="field">
            <label className="label" htmlFor="brand-level">
              品牌等级
            </label>
            <select
              id="brand-level"
              className="select"
              value={form.level}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, level: event.target.value as BrandLevel }))
              }
            >
              {BRAND_LEVEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="label labelRequired" htmlFor="brand-payment-term">
              付款账期（天）
            </label>
            <input
              id="brand-payment-term"
              className="input mono"
              type="number"
              min={0}
              max={365}
              step={1}
              value={form.paymentTermDays}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, paymentTermDays: event.target.value }))
              }
            />
            <span className="hint">0 表示现结；结算单的到期日 = 账期结束日 + 该天数。</span>
          </div>

          <div className="field">
            <label className="label" htmlFor="brand-invoice-title">
              发票抬头
            </label>
            <input
              id="brand-invoice-title"
              className="input"
              type="text"
              placeholder="与营业执照一致"
              value={form.invoiceTitle}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, invoiceTitle: event.target.value }))
              }
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="brand-tax-no">
              税号
            </label>
            <input
              id="brand-tax-no"
              className="input mono"
              type="text"
              placeholder="纳税人识别号"
              value={form.taxNo}
              onChange={(event) => setForm((prev) => ({ ...prev, taxNo: event.target.value }))}
            />
          </div>

          <div className="field fieldFull">
            <label className="label" htmlFor="brand-remark">
              备注
            </label>
            <textarea
              id="brand-remark"
              className="textarea"
              rows={3}
              placeholder="开票要求、对接节奏、注意事项等"
              value={form.remark}
              onChange={(event) => setForm((prev) => ({ ...prev, remark: event.target.value }))}
            />
          </div>

          {formError !== null && <div className="field fieldFull errorText">{formError}</div>}
        </div>
      </Modal>

      {/* ---------------- 删除确认 ---------------- */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除品牌"
        danger
        confirmText="删除"
        loading={deleteMutation.isPending}
        message={
          <>
            将删除品牌 <strong>{deleteTarget?.name}</strong>
            {(deleteTarget?.contractCount ?? 0) > 0 && (
              <>
                ，该品牌下还有 <strong>{formatInteger(deleteTarget?.contractCount ?? 0)}</strong>{' '}
                个合同，删除后这些合同会失去品牌归属（合同与结算金额不会变化）
              </>
            )}
            。删除会写入审计日志，但品牌资料无法恢复。
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
