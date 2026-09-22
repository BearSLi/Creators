import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 防抖值。
 *
 * 用途：达人/合同/结算列表的关键词搜索。每敲一个字就请求一次会同时压垮后端与浏览器，
 * 且后发先至时列表会闪回旧结果。
 * 注意返回的是"延迟后的值"，调用方需要把它合并进查询条件（见 useTableQuery 的 setFilterDebounced）。
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    // 依赖变化时清掉上一个定时器：这是防抖的本质——只有最后一次输入会落地
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/**
 * 防抖回调。
 * 与 useDebounce 的区别：这里不产生新值，只推迟副作用，适合"搜索按钮/输入即触发请求"的场景。
 */
export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delay = 300,
): (...args: Args) => void {
  const timerRef = useRef<number | null>(null);
  const callbackRef = useRef(callback);

  // 用 ref 持有最新回调：否则父组件每次渲染生成的新函数都会重置定时器
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return useCallback(
    (...args: Args) => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => callbackRef.current(...args), delay);
    },
    [delay],
  );
}
