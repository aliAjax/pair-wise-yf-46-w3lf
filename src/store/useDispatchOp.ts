import { useCallback } from "react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { enqueueOffline, submitOp, type NewOpInput } from "../store/rundownSlice";

/** 统一编排操作入口：在线即时提交走乐观锁；断网先占序号排队并本地预演 */
export function useDispatchOp() {
  const dispatch = useAppDispatch();
  const online = useAppSelector((state) => state.rundown.online);
  return useCallback((input: NewOpInput) => {
    if (online) return dispatch(submitOp(input));
    return dispatch(enqueueOffline(input));
  }, [dispatch, online]);
}
