-- ============================================================================
-- 业务编号序列表
-- ----------------------------------------------------------------------------
-- 为什么这张表不由 schema.prisma 管理：
--   Prisma 的模型都对应业务实体，而 code_sequences 是纯粹的**基础设施**：
--   它服务于 CodeGeneratorService，与任何业务字段都没有关系。
--   放进 schema 会让它出现在所有 Prisma 类型里，反而干扰业务代码的可读性。
--
-- 为什么不用 PostgreSQL 的 SEQUENCE：
--   业务编号需要按「资源类型 + 年份」分组重置（CR-2026-000123、CT-2026-000045），
--   而 SEQUENCE 是按对象全局递增的，每年都要新建一批序列，难以管理。
--
-- 为什么不用 count(*) + 1：
--   存在并发读-改-写竞态；且软删除后计数不连续，会撞上编号的唯一索引。
--
-- 实现方式：INSERT ... ON CONFLICT DO UPDATE ... RETURNING 原子自增，
--   且必须与业务写入处于**同一事务**内调用
--   （见 CodeGeneratorService.next(prefix, tx)），
--   这样业务失败时编号一并回滚，不会留下空洞。
-- ============================================================================

CREATE TABLE IF NOT EXISTS code_sequences (
  scope      VARCHAR(64) PRIMARY KEY,
  value      BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE code_sequences IS '业务编号自增序列（按 前缀-年份 分组），由 CodeGeneratorService 原子递增';
COMMENT ON COLUMN code_sequences.scope IS '序列分组，如 CR-2026 / CT-2026 / ST-2026';
COMMENT ON COLUMN code_sequences.value IS '当前已分配的最大序号';
