import * as argon2 from "argon2";

const passwordOptions: argon2.HashOptions = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1
};

export interface PasswordService {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export function createPasswordService(): PasswordService {
  return {
    hash: (password) => argon2.hash(password, passwordOptions),
    verify: async (hash, password) => {
      try {
        return await argon2.verify(hash, password);
      } catch {
        return false;
      }
    }
  };
}
