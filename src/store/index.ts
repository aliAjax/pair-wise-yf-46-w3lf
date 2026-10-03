import { configureStore } from "@reduxjs/toolkit";
import ledgerReducer from "./ledgerSlice";

export const store = configureStore({
  reducer: { ledger: ledgerReducer },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
