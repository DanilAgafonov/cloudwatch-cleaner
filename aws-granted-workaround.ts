if (process.env["AWS_ACCESS_KEY_ID"] && process.env["AWS_PROFILE"]) {
  delete process.env["AWS_PROFILE"];
}
