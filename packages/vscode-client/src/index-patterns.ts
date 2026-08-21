export function configurationWorkspaceGlobs(suffixes: readonly string[]): readonly string[] {
  const typedExtensions =
    "service,socket,timer,path,mount,automount,swap,target,device,slice,scope," +
    "network,netdev,link,dnssd,dns-delegate,nspawn,container,volume,pod,kube,image,build," +
    "artifact,rules,hwdb,preset,pcrlock,rr,user,group,membership,oomrule,positive,negative";
  const dropInExtensions =
    "service,socket,timer,path,mount,automount,swap,target,device,slice,scope," +
    "network,netdev,link,dnssd,dns-delegate,nspawn,container,volume,pod,kube,image,build,artifact";
  const configurationNames =
    "system,user,journald,logind,resolved,timesyncd,networkd,coredump,oomd,homed,pstore," +
    "sleep,systemd-sleep,iocost,journal-remote,journal-upload,udev,sysext,confext,ukify,uki";
  const exactNames =
    "fstab,crypttab,veritytab,integritytab,clonetab,loader.conf,install.conf,hostname," +
    "os-release,initrd-release,machine-info,locale.conf,vconsole.conf,cmdline,entry-token," +
    "mkosi.conf,mkosi.local.conf,mkosi.tools.conf,mkosi.initrd.conf,mkosi.version";
  const globs = [
    `**/*.{${typedExtensions}}`,
    `**/*.{${dropInExtensions}}.d/*.conf`,
    `**/{${configurationNames}}.conf`,
    `**/{${configurationNames}}.conf.d/*.conf`,
    "**/journald@*.conf",
    "**/journald@*.conf.d/*.conf",
    "**/{tmpfiles.d,sysusers.d,sysctl.d,modules-load.d,binfmt.d,repart.d,sysupdate.d,environment.d}/*.conf",
    "**/portable/profile/**/*.conf",
    "**/loader/entries/*.conf",
    "**/kernel/install.conf.d/*.conf",
    `**/{${exactNames}}`,
    "**/{mkosi.conf.d,mkosi.local,mkosi.tools.conf,mkosi.initrd.conf,mkosi.presets,mkosi.profiles,mkosi.images}/**/*.conf",
    "**/mkosi.presets/*",
    "**/mkosi.profiles/*",
    "**/mkosi.images/*.conf",
    "**/mkosi.uki-profiles/*.conf",
    "**/mkosi.repart/**/*.conf",
    "**/extension-release.d/extension-release.*",
  ];
  const suffixNames = suffixes.map((suffix) => suffix.replace(/^\./u, "")).join(",");
  if (suffixNames === "") return globs;
  const suffixPattern = suffixNames.includes(",") ? `{${suffixNames}}` : suffixNames;
  return [
    ...globs,
    `**/*.{${typedExtensions}}.${suffixPattern}`,
    `**/*.{${dropInExtensions}}.d/*.conf.${suffixPattern}`,
    `**/{${configurationNames}}.conf.${suffixPattern}`,
    `**/{${configurationNames}}.conf.d/*.conf.${suffixPattern}`,
    `**/{tmpfiles.d,sysusers.d,sysctl.d,modules-load.d,binfmt.d,repart.d,sysupdate.d,environment.d}/*.conf.${suffixPattern}`,
    `**/{portable/profile,loader/entries,kernel/install.conf.d,mkosi.repart}/**/*.conf.${suffixPattern}`,
    `**/journald@*.conf.${suffixPattern}`,
    `**/journald@*.conf.d/*.conf.${suffixPattern}`,
    `**/{mkosi.conf,mkosi.local.conf,mkosi.tools.conf,mkosi.initrd.conf}.${suffixPattern}`,
    `**/{mkosi.conf.d,mkosi.local,mkosi.tools.conf,mkosi.initrd.conf,mkosi.presets,mkosi.profiles,mkosi.images}/**/*.conf.${suffixPattern}`,
  ];
}
