export interface WindowManager {
  count(): number;
}

export function createWindowManager(): WindowManager {
  return {
    count: () => 0
  };
}
