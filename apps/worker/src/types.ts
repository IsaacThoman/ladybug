export type { ScanEvent, Screenshot } from "@ladybug/shared";

/** Omit over each member of a union, keeping it a union. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
