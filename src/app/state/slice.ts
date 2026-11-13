import type { StateCreator } from "zustand";
import type { AppStore } from "../storeTypes";

/** 每个切片只能声明自己拥有的字段，同时可以通过 get() 调用其他域动作。 */
export type StoreSlice<Keys extends keyof AppStore> = StateCreator<
  AppStore, [], [], Pick<AppStore, Keys>
>;
