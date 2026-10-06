# The OCI image: the service as uid 1000, fine with a read-only root filesystem and a
# writable /tmp mounted by the runtime.
{
  dockerTools,
  cacert,
  finreports,
}:
dockerTools.buildLayeredImage {
  name = "finreports";
  tag = "latest";
  contents = [cacert];
  extraCommands = ''
    mkdir -m 1777 tmp
  '';
  config = {
    Cmd = ["${finreports}/bin/finreports"];
    User = "1000:1000";
    ExposedPorts."8080/tcp" = {};
    Env = [
      "NODE_ENV=production"
      "PORT=8080"
      "HOST=0.0.0.0"
      "SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
    ];
    Labels = {
      "org.opencontainers.image.source" = "https://github.com/AlexanderOtavka/finreports";
      "org.opencontainers.image.description" = finreports.meta.description;
      "org.opencontainers.image.licenses" = "MIT";
    };
  };
}
