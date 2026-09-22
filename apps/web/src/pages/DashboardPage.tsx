import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { MoneyText } from '@/components/MoneyText';
import { StatusTag } from '@/components/StatusTag';
import { ErrorState } from '@/components/ErrorState';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { usePermission } from '@/hooks/usePermission';
import { getDashboardOverview } from '@/api/dashboard';
import { resolveErrorMessage } from '@/api/client';
import {
  formatCount,
  formatMoney,
  formatPercentValue,
  formatYuan,
  shiftDays,
} from '@/utils/format';
import { platformLabel, verticalLabel } from '@/utils/constants';
import { P } from '@/utils/permissions';
import styles from './DashboardPage.module.css';

/**
 * 经营看板。
 *
 * 数据来自单个聚合接口 /dashboard/overview：首屏要同时展示 KPI、漏斗、趋势、
 * 分布与待办，如果拆成 6 个请求，任何一次慢响应都会让整个看板看起来"卡住"。
 * 聚合接口也让后端的统计口径集中在一处，避免前端拼数据导致口径漂移。
 *
 * 图表按需注册（echarts/core）而不是全量引入：全量 echarts 会给首屏多加数百 KB。
 */

type RangePreset = '7d' | '30d' | '90d';

const RANGE_LABELS: Record<RangePreset, string> = {
  '7d': '近 7 天',
  '30d': '近 30 天',
  '90d': '近 90 天',
};

const RANGE_DAYS: Record<RangePreset, number> = { '7d': 7, '30d': 30, '90d': 90 };

/** 与设计令牌保持一致的图表配色，避免图表和界面像两个产品 */
const CHART_COLORS = ['#4f5bd6', '#2563eb', '#16a34a', '#d97706', '#dc2626', '#0891b2', '#7c3aed'];

export default function DashboardPage() {
  const [preset, setPreset] = useState<RangePreset>('30d');
  const { has } = usePermission();
  const navigate = useNavigate();

  const query = useMemo(
    () => ({ from: shiftDays(-RANGE_DAYS[preset]), to: shiftDays(0) }),
    [preset],
  );

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['dashboard', 'overview', query],
    queryFn: () => getDashboardOverview(query),
    // 看板数据变动不频繁，切走再切回不必重新请求
    staleTime: 120_000,
  });

  // 侧栏折叠会改变内容区宽度但不触发 window.resize，图表必须靠 ResizeObserver 自适应
  const chartHostRef = useRef<HTMLDivElement | null>(null);
  const [chartKey, setChartKey] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const attachObserver = (node: HTMLDivElement | null) => {
    chartHostRef.current = node;
    observerRef.current?.disconnect();
    if (!node || typeof ResizeObserver === 'undefined') return;
    let lastWidth = node.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? lastWidth;
      // 只有宽度真正变化才重挂图表，否则 ResizeObserver 的每帧回调会造成抖动
      if (Math.abs(width - lastWidth) > 8) {
        lastWidth = width;
        setChartKey((prev) => prev + 1);
      }
    });
    observer.observe(node);
    observerRef.current = observer;
  };

  if (isLoading) {
    return (
      <div className="page">
        <PageHeader title="经营看板" subtitle="达人合作全链路经营指标" />
        <LoadingSkeleton variant="card" rows={4} />
        <div style={{ marginTop: 'var(--space-4)' }}>
          <LoadingSkeleton rows={6} columns={4} />
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="page">
        <PageHeader title="经营看板" subtitle="达人合作全链路经营指标" />
        <div className="card">
          <ErrorState message={resolveErrorMessage(error)} onRetry={() => void refetch()} />
        </div>
      </div>
    );
  }

  const { kpi, funnel, revenueTrend, platformDistribution, verticalDistribution, topCreators, pendingTodos } =
    data;

  /* ---------------- 图表配置 ---------------- */

  const revenueTrendOption: EChartsOption = {
    color: CHART_COLORS,
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      // 营收用后端下发的字符串元展示，前端不重新计算金额
      valueFormatter: (value) => `¥${formatMoney(String(value ?? 0))}`,
    },
    legend: { data: ['营收（元）', '发布内容数'], right: 0, top: 0, icon: 'roundRect', itemHeight: 8 },
    xAxis: {
      type: 'category',
      data: revenueTrend.map((point) => point.date.slice(5)),
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#e3e7ef' } },
      axisLabel: { color: '#8b93a5', fontSize: 11 },
    },
    yAxis: [
      {
        type: 'value',
        name: '营收',
        nameTextStyle: { color: '#8b93a5', fontSize: 11 },
        axisLabel: { color: '#8b93a5', fontSize: 11, formatter: (value: number) => formatCount(value) },
        splitLine: { lineStyle: { color: '#f0f2f7' } },
      },
      {
        type: 'value',
        name: '内容数',
        nameTextStyle: { color: '#8b93a5', fontSize: 11 },
        axisLabel: { color: '#8b93a5', fontSize: 11 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '营收（元）',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.08 },
        data: revenueTrend.map((point) => Number(point.revenueYuan)),
      },
      {
        name: '发布内容数',
        type: 'bar',
        yAxisIndex: 1,
        barWidth: 10,
        itemStyle: { color: 'rgba(37, 99, 235, 0.35)', borderRadius: [3, 3, 0, 0] },
        data: revenueTrend.map((point) => point.contentCount),
      },
    ],
  };

  const funnelOption: EChartsOption = {
    color: [CHART_COLORS[0]],
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: {
      type: 'value',
      axisLabel: { color: '#8b93a5', fontSize: 11 },
      splitLine: { lineStyle: { color: '#f0f2f7' } },
    },
    yAxis: {
      type: 'category',
      // 漏斗从"线索"到"合作中"，顺序由后端下发，前端不重排
      data: [...funnel].reverse().map((stage) => stage.label),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#5a6376', fontSize: 12 },
    },
    series: [
      {
        type: 'bar',
        barWidth: 14,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right', color: '#5a6376', fontSize: 11 },
        data: [...funnel].reverse().map((stage) => stage.count),
      },
    ],
  };

  const platformOption: EChartsOption = {
    color: CHART_COLORS,
    tooltip: {
      trigger: 'item',
      formatter: (params) => {
        const item = params as { name: string; value: number; percent?: number };
        return `${item.name}<br/>营收 ¥${formatMoney(item.value)}（${item.percent ?? 0}%）`;
      },
    },
    legend: { bottom: 0, icon: 'circle', itemHeight: 8, textStyle: { fontSize: 11, color: '#5a6376' } },
    series: [
      {
        type: 'pie',
        radius: ['46%', '68%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { formatter: '{b}\n{d}%', fontSize: 11, color: '#5a6376' },
        data: platformDistribution.map((item) => ({
          name: platformLabel(String(item.platform)),
          value: Number(item.revenueYuan),
        })),
      },
    ],
  };

  const verticalOption: EChartsOption = {
    color: [CHART_COLORS[2]],
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: {
      type: 'category',
      data: verticalDistribution.map((item) => verticalLabel(String(item.vertical))),
      axisLabel: { color: '#8b93a5', fontSize: 11, interval: 0, rotate: verticalDistribution.length > 6 ? 30 : 0 },
      axisLine: { lineStyle: { color: '#e3e7ef' } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#8b93a5', fontSize: 11 },
      splitLine: { lineStyle: { color: '#f0f2f7' } },
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 28,
        itemStyle: { borderRadius: [4, 4, 0, 0] },
        data: verticalDistribution.map((item) => item.creatorCount),
      },
    ],
  };

  const hasTrend = revenueTrend.length > 0;
  const hasPlatform = platformDistribution.some((item) => Number(item.revenueYuan) > 0);
  const hasVertical = verticalDistribution.length > 0;

  return (
    <div className="page">
      <PageHeader
        title="经营看板"
        subtitle={`统计区间 ${query.from} ~ ${query.to}，金额单位：元`}
        actions={
          <div className="row">
            {(Object.keys(RANGE_LABELS) as RangePreset[]).map((item) => (
              <button
                key={item}
                type="button"
                className={`btn btnSm ${preset === item ? 'btnPrimary' : ''}`}
                onClick={() => setPreset(item)}
              >
                {RANGE_LABELS[item]}
              </button>
            ))}
            <button
              type="button"
              className="btn btnSm"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              {isFetching && <span className="spinner" aria-hidden="true" />}
              刷新
            </button>
          </div>
        }
      />

      {/* KPI：先给"总量与增量"，再给"待处理"，符合管理者从上到下的阅读顺序 */}
      <div className="grid gridCols4">
        <StatCard
          label="达人数"
          value={formatCount(kpi.creatorTotal)}
          unit="位"
          accent="primary"
          hint={`其中合作中 ${kpi.creatorActive} 位`}
        />
        <StatCard
          label="本月新签约"
          value={formatCount(kpi.creatorSignedThisMonth)}
          unit="位"
          accent="info"
          hint="状态流转到「已签约」的达人"
        />
        <StatCard
          label="已发布内容"
          value={formatCount(kpi.contentPublished)}
          unit="条"
          delta={kpi.contentPublishedDelta}
          accent="success"
          hint="环比上一区间"
        />
        <StatCard
          label="平均互动率"
          value={formatPercentValue(kpi.avgEngagementRate)}
          accent="warning"
          hint="各平台账号互动率均值"
        />
      </div>

      <div className="grid gridCols4" style={{ marginTop: 'var(--space-4)' }}>
        <StatCard
          label="营收金额"
          value={<MoneyText value={kpi.revenueYuan} variant="compact" />}
          delta={kpi.revenueDelta}
          accent="success"
          hint="按内容发布归因"
        />
        <StatCard
          label="待结算金额"
          value={<MoneyText value={kpi.settlementPendingYuan} variant="compact" />}
          unit={`${kpi.settlementPendingCount} 单`}
          accent="danger"
          hint="财务需在本月处理的敞口"
        />
        <StatCard
          label="待办事项"
          value={formatCount(pendingTodos.reduce((sum, item) => sum + item.count, 0))}
          unit="项"
          accent="warning"
          hint={pendingTodos.map((item) => item.label).join(' / ') || '暂无待办'}
        />
        <StatCard
          label="漏斗转化"
          value={
            funnel.length > 1
              ? // 漏斗首尾比值只用于"心里有数"的粗看，精确转化率以后端统计为准
                formatPercentValue(
                  Math.round(((funnel[funnel.length - 1]?.count ?? 0) / (funnel[0]?.count || 1)) * 1000) / 10,
                )
              : '—'
          }
          accent="primary"
          hint="首个阶段 → 最后阶段"
        />
      </div>

      {/* 图表区：左边趋势（时间序列）右边漏斗（阶段分布），下面两块分布 */}
      <div ref={attachObserver} style={{ marginTop: 'var(--space-4)' }}>
        <div className={styles.chartGrid}>
          <section className="card">
            <div className="cardHeader">
              <span className="cardTitle">营收与内容趋势</span>
              <span className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
                柱状为内容产出，折线为营收
              </span>
            </div>
            <div className="cardBody">
              {hasTrend ? (
                <ReactECharts
                  key={`trend-${chartKey}`}
                  option={revenueTrendOption}
                  style={{ height: 300 }}
                  notMerge
                  lazyUpdate
                />
              ) : (
                <div className="emptyInline">该区间暂无营收与内容数据</div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="cardHeader">
              <span className="cardTitle">达人转化漏斗</span>
              <span className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
                按当前状态快照统计
              </span>
            </div>
            <div className="cardBody">
              {funnel.length > 0 ? (
                <ReactECharts
                  key={`funnel-${chartKey}`}
                  option={funnelOption}
                  style={{ height: 300 }}
                  notMerge
                  lazyUpdate
                />
              ) : (
                <div className="emptyInline">暂无达人阶段数据</div>
              )}
            </div>
          </section>
        </div>

        <div className={styles.chartGrid} style={{ marginTop: 'var(--space-4)' }}>
          <section className="card">
            <div className="cardHeader">
              <span className="cardTitle">平台营收结构</span>
            </div>
            <div className="cardBody">
              {hasPlatform ? (
                <ReactECharts
                  key={`platform-${chartKey}`}
                  option={platformOption}
                  style={{ height: 300 }}
                  notMerge
                  lazyUpdate
                />
              ) : (
                <div className="emptyInline">该区间暂无平台营收数据</div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="cardHeader">
              <span className="cardTitle">垂类达人分布</span>
            </div>
            <div className="cardBody">
              {hasVertical ? (
                <ReactECharts
                  key={`vertical-${chartKey}`}
                  option={verticalOption}
                  style={{ height: 300 }}
                  notMerge
                  lazyUpdate
                />
              ) : (
                <div className="emptyInline">暂无垂类分布数据</div>
              )}
            </div>
          </section>
        </div>
      </div>

      <div className={styles.bottomGrid} style={{ marginTop: 'var(--space-4)' }}>
        <section className="card">
          <div className="cardHeader">
            <span className="cardTitle">TOP 达人</span>
            <span className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
              按营收排序
            </span>
          </div>
          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 48 }}>#</th>
                  <th>达人</th>
                  <th className="textRight">营收（元）</th>
                  <th className="textRight">内容数</th>
                  <th className="textRight">平均播放</th>
                </tr>
              </thead>
              <tbody>
                {topCreators.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <div className="emptyInline">该区间暂无达人营收记录</div>
                    </td>
                  </tr>
                )}
                {topCreators.map((creator, index) => (
                  <tr key={creator.creatorId}>
                    <td className="mono subtle">{index + 1}</td>
                    <td>
                      <Link to={`/creators/${creator.creatorId}`}>{creator.creatorName}</Link>
                    </td>
                    <td className="textRight">
                      <MoneyText value={creator.revenueYuan} variant="plain" />
                    </td>
                    <td className="textRight mono">{formatCount(creator.contentCount)}</td>
                    <td className="textRight mono">{formatCount(creator.avgViewCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <div className="cardHeader">
            <span className="cardTitle">待办提醒</span>
            <span className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
              点击直达处理页面
            </span>
          </div>
          <div className="cardBody stack">
            {pendingTodos.length === 0 && <div className="emptyInline">当前没有待处理事项</div>}
            {pendingTodos.map((todo) => (
              <button
                key={todo.type}
                type="button"
                className={styles.todoItem}
                // link 由后端下发，前端不拼路径：新增待办类型无需改前端
                onClick={() => navigate(todo.link)}
                disabled={!todo.link}
              >
                <span className={styles.todoLabel}>{todo.label}</span>
                <StatusTag tone={todo.count > 0 ? 'warning' : 'neutral'} size="sm">
                  {todo.count} 项
                </StatusTag>
              </button>
            ))}

            {has(P.AI_RUN) && (
              <div className={styles.aiHint}>
                <span aria-hidden="true">✨</span>
                <div>
                  <div>需要写脚本或做合规预检？</div>
                  <Link to="/ai/workbench">进入 AI 工作台</Link>
                  <span className="subtle"> · 每次调用都会展示 token 与成本</span>
                </div>
              </div>
            )}

            <div className={styles.amountNote}>
              看板金额均为后端按分润规则计算后的结果，前端仅做展示；
              如需核对口径请查看对应结算单的「计算链路」。
            </div>
          </div>
        </section>
      </div>

      <p className="subtle" style={{ marginTop: 'var(--space-4)', fontSize: 'var(--font-size-xs)' }}>
        合计口径提示：营收合计 {formatYuan(kpi.revenueYuan)}，待结算 {formatYuan(kpi.settlementPendingYuan)}。
      </p>
    </div>
  );
}
