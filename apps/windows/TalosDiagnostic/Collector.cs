using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Management;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

namespace TalosDiagnostic
{
    // Builds the same report as public/diag.ps1 on the website (same JSON
    // keys, so /api/diag/analyze and the widget read both) without starting
    // PowerShell. Read-only: nothing on the PC is modified. Each section is
    // best-effort; a failure leaves it empty and adds a short note.
    internal sealed class Collector
    {
        public static readonly string[] Steps =
        {
            "Système d'exploitation",
            "Processeur",
            "Carte graphique",
            "Stockage",
            "Réseau",
            "Sécurité",
            "Mises à jour Windows",
            "Températures",
            "Stabilité du système",
            "Performances",
            "Processus et démarrage",
            "Logiciels installés",
        };

        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        const double GB = 1024d * 1024 * 1024;
        const double KbPerGb = 1024d * 1024;

        readonly List<string> notes = new List<string>();
        double ramTotalKb, ramFreeKb, pageTotalKb, pageFreeKb;
        double? cpuPercent;

        public Dictionary<string, object> Run(IProgress<int> progress, CancellationToken ct)
        {
            var report = new Dictionary<string, object>();
            var steps = new Action[]
            {
                () => report["os"] = CollectOs(),
                () => report["cpu"] = CollectCpu(),
                () => report["gpus"] = CollectGpus(),
                () => { report["disks"] = CollectLogicalDisks(); report["physical_disks"] = CollectPhysicalDisks(); },
                () => report["network"] = CollectNetwork(),
                () => report["security"] = CollectSecurity(),
                () => report["updates"] = CollectUpdates(),
                () => report["temperatures"] = CollectTemperatures(),
                () => report["stability"] = CollectStability(),
                () => report["performance"] = CollectPerformance(),
                () => { report["procs"] = CollectProcesses(); report["startup"] = CollectStartup(); },
                () => report["software"] = CollectSoftware(),
            };

            for (var i = 0; i < steps.Length; i++)
            {
                ct.ThrowIfCancellationRequested();
                progress?.Report(i);
                try { steps[i](); }
                catch (Exception ex) { Note(Steps[i], ex); }
            }

            report["collected_at"] = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss", Inv);
            report["collector"] = "talos-diagnostic-app/" + AppInfo.Version;
            if (notes.Count > 0) report["notes"] = notes;
            progress?.Report(steps.Length);
            return report;
        }

        // ── Sections ────────────────────────────────────────────────────────

        Dictionary<string, object> CollectOs()
        {
            var os = Wmi(@"root\cimv2",
                "SELECT Caption, Version, BuildNumber, OSArchitecture, LastBootUpTime, TotalVisibleMemorySize, " +
                "FreePhysicalMemory, SizeStoredInPagingFiles, FreeSpaceInPagingFiles FROM Win32_OperatingSystem").First();

            ramTotalKb = Dbl(os["TotalVisibleMemorySize"]) ?? 0;
            ramFreeKb = Dbl(os["FreePhysicalMemory"]) ?? 0;
            pageTotalKb = Dbl(os["SizeStoredInPagingFiles"]) ?? 0;
            pageFreeKb = Dbl(os["FreeSpaceInPagingFiles"]) ?? 0;
            var boot = CimDate(os["LastBootUpTime"]);
            const string currentVersion = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

            return new Dictionary<string, object>
            {
                ["name"] = Str(os["Caption"]),
                ["version"] = Str(os["Version"]),
                ["build"] = Str(os["BuildNumber"]),
                ["display_version"] = RegValue(RegistryHive.LocalMachine, currentVersion, "DisplayVersion") as string,
                ["ubr"] = RegValue(RegistryHive.LocalMachine, currentVersion, "UBR"),
                ["arch"] = Str(os["OSArchitecture"]),
                ["uptime"] = boot.HasValue ? R1((DateTime.Now - boot.Value).TotalHours) : null,
                ["ram_total_gb"] = R1(ramTotalKb / KbPerGb),
                ["ram_free_gb"] = R1(ramFreeKb / KbPerGb),
                ["pagefile_total_gb"] = R1(pageTotalKb / KbPerGb),
                ["pagefile_used_gb"] = R1((pageTotalKb - pageFreeKb) / KbPerGb),
                ["last_boot"] = boot?.ToString("yyyy-MM-ddTHH:mm:ss", Inv),
            };
        }

        Dictionary<string, object> CollectCpu()
        {
            var cpus = Wmi(@"root\cimv2",
                "SELECT Name, NumberOfCores, NumberOfLogicalProcessors, LoadPercentage, MaxClockSpeed, SocketDesignation FROM Win32_Processor");
            var first = cpus.First();

            // Win32_Processor.LoadPercentage often reads 0 on modern CPUs: measure
            // the real load over one second from the system idle/kernel/user times.
            cpuPercent = MeasureCpuPercent(1000);
            var loads = cpus.Select(c => Dbl(c["LoadPercentage"])).Where(l => l.HasValue).Select(l => l.Value).ToList();
            var load = cpuPercent ?? (loads.Count > 0 ? loads.Average() : (double?)null);

            return new Dictionary<string, object>
            {
                ["name"] = Str(first["Name"]),
                ["cores"] = cpus.Sum(c => Int(c["NumberOfCores"]) ?? 0),
                ["threads"] = cpus.Sum(c => Int(c["NumberOfLogicalProcessors"]) ?? 0),
                ["load"] = load.HasValue ? (object)(int)Math.Round(load.Value) : null,
                ["max_mhz"] = Int(first["MaxClockSpeed"]),
                ["socket"] = Str(first["SocketDesignation"]),
                ["sockets"] = cpus.Count,
            };
        }

        List<object> CollectGpus()
        {
            var vram = ReadVramFromRegistry();
            var gpus = new List<object>();
            foreach (var g in Wmi(@"root\cimv2",
                "SELECT Name, AdapterRAM, DriverVersion, DriverDate, CurrentHorizontalResolution, " +
                "CurrentVerticalResolution, CurrentRefreshRate, Status FROM Win32_VideoController"))
            {
                var name = Str(g["Name"]);
                // AdapterRAM is a 32-bit value capped at 4 GB; the driver key has the real size.
                double? bytes = name != null && vram.TryGetValue(name, out var regBytes) ? regBytes : Dbl(g["AdapterRAM"]);
                var width = Int(g["CurrentHorizontalResolution"]);
                var height = Int(g["CurrentVerticalResolution"]);
                gpus.Add(new Dictionary<string, object>
                {
                    ["name"] = name,
                    ["ram_mb"] = bytes.HasValue ? R0(bytes.Value / (1024 * 1024)) : null,
                    ["driver"] = Str(g["DriverVersion"]),
                    ["driver_date"] = CimDate(g["DriverDate"])?.ToString("yyyy-MM-dd", Inv) ?? "?",
                    ["resolution"] = width.HasValue && height.HasValue ? width + "x" + height : null,
                    ["refresh_hz"] = Int(g["CurrentRefreshRate"]),
                    ["status"] = Str(g["Status"]),
                });
            }
            return gpus;
        }

        List<object> CollectLogicalDisks()
        {
            var disks = new List<object>();
            foreach (var d in Wmi(@"root\cimv2", "SELECT DeviceID, VolumeName, Size, FreeSpace FROM Win32_LogicalDisk WHERE DriveType=3"))
            {
                var size = Dbl(d["Size"]) ?? 0;
                var free = Dbl(d["FreeSpace"]) ?? 0;
                disks.Add(new Dictionary<string, object>
                {
                    ["letter"] = Str(d["DeviceID"]),
                    ["label"] = Str(d["VolumeName"]),
                    ["total_gb"] = R1(size / GB),
                    ["free_gb"] = R1(free / GB),
                    ["pct_used"] = size > 0 ? R0((1 - free / size) * 100) : 0d,
                });
            }
            return disks;
        }

        List<object> CollectPhysicalDisks()
        {
            const string storage = @"root\Microsoft\Windows\Storage";

            // Win32_DiskDrive.Status reflects the drive's own SMART verdict
            // ("OK" / "Pred Fail") and, unlike the counters below, needs no admin rights.
            var smartStatus = new Dictionary<string, string>();
            try
            {
                foreach (var d in Wmi(@"root\cimv2", "SELECT Index, Status FROM Win32_DiskDrive"))
                    smartStatus[Str(d["Index"]) ?? ""] = Str(d["Status"]);
            }
            catch (Exception ex) { Note("Statut SMART", ex); }

            // Reliability counters (hours, temperature, wear) hang off each disk
            // through an association; Windows only returns them to administrators.
            var counters = new Dictionary<string, Dictionary<string, object>>();
            try
            {
                using (var searcher = new ManagementObjectSearcher(new ManagementScope(storage), new ObjectQuery("SELECT * FROM MSFT_PhysicalDisk")))
                using (var physical = searcher.Get())
                {
                    foreach (ManagementObject disk in physical)
                    {
                        using (disk)
                        using (var related = disk.GetRelated("MSFT_StorageReliabilityCounter"))
                        {
                            foreach (ManagementBaseObject counter in related)
                                using (counter) counters[Str(disk["DeviceId"]) ?? ""] = ToRow(counter);
                        }
                    }
                }
            }
            catch (Exception ex) { Note("Compteurs SMART", ex); }
            if (counters.Count == 0 && !IsElevated())
                lock (notes) notes.Add("Compteurs SMART : réservés aux administrateurs (santé globale du disque indiquée)");

            var disks = new List<object>();
            foreach (var p in Wmi(storage,
                "SELECT DeviceId, FriendlyName, MediaType, BusType, Size, HealthStatus, OperationalStatus FROM MSFT_PhysicalDisk"))
            {
                var id = Str(p["DeviceId"]) ?? "";
                counters.TryGetValue(id, out var c);
                smartStatus.TryGetValue(id, out var smart);
                var temperature = c != null ? Int(c["Temperature"]) : null;
                disks.Add(new Dictionary<string, object>
                {
                    ["friendly_name"] = Str(p["FriendlyName"]),
                    ["media_type"] = MediaTypeName(Int(p["MediaType"])),
                    ["bus_type"] = BusTypeName(Int(p["BusType"])),
                    ["size_gb"] = R1((Dbl(p["Size"]) ?? 0) / GB),
                    ["health_status"] = HealthName(Int(p["HealthStatus"])),
                    ["operational_status"] = OperationalStatusName(p["OperationalStatus"]),
                    ["smart_status"] = smart,
                    ["hours_used"] = c != null ? Int(c["PowerOnHours"]) : null,
                    ["read_errors"] = c != null ? Int(c["ReadErrorsUncorrected"]) : null,
                    ["temperature_c"] = temperature > 0 ? temperature : null,
                    ["wear_pct"] = c != null ? Int(c["Wear"]) : null,
                });
            }
            return disks;
        }

        Dictionary<string, object> CollectNetwork()
        {
            var adapters = new List<object>();
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback || ni.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;

                string ip = null;
                try
                {
                    ip = ni.GetIPProperties().UnicastAddresses
                        .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork)
                        .Select(a => a.Address.ToString())
                        .FirstOrDefault();
                }
                catch { }

                var text = ni.Name + " " + ni.Description;
                var type = ni.NetworkInterfaceType == NetworkInterfaceType.Wireless80211 ? "WiFi"
                    : Regex.IsMatch(text, "VPN|TAP-|WireGuard|OpenVPN|Tunnel", RegexOptions.IgnoreCase) ? "VPN"
                    : "Ethernet";

                adapters.Add(new Dictionary<string, object>
                {
                    ["name"] = ni.Name,
                    ["description"] = ni.Description,
                    ["type"] = type,
                    ["virtual"] = Regex.IsMatch(text, "Hyper-V|VirtualBox|VMware|vEthernet|Virtual", RegexOptions.IgnoreCase),
                    ["speed_mbps"] = ni.Speed > 0 ? (object)Math.Round(ni.Speed / 1e6) : null,
                    ["ip"] = ip,
                });
            }

            long? pingMs = null;
            var pingOk = false;
            try
            {
                using (var ping = new Ping())
                {
                    var reply = ping.Send("8.8.8.8", 2000);
                    pingOk = reply != null && reply.Status == IPStatus.Success;
                    if (pingOk) pingMs = reply.RoundtripTime;
                }
            }
            catch { }

            double? dnsMs = null;
            try
            {
                var sw = Stopwatch.StartNew();
                Dns.GetHostAddresses("www.google.com");
                dnsMs = Math.Round(sw.Elapsed.TotalMilliseconds);
            }
            catch { }

            return new Dictionary<string, object>
            {
                ["adapters"] = adapters,
                // Some networks block ping: an HTTP request also proves connectivity.
                ["internet_ok"] = pingOk || HttpReachable("https://www.talos-int.com/robots.txt"),
                ["ping_ms"] = pingMs,
                ["dns_latency_ms"] = dnsMs,
            };
        }

        Dictionary<string, object> CollectSecurity()
        {
            var sec = new Dictionary<string, object>();

            try
            {
                var mp = Wmi(@"root\Microsoft\Windows\Defender",
                    "SELECT AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated, AntispywareEnabled, AMRunningMode FROM MSFT_MpComputerStatus")
                    .FirstOrDefault();
                if (mp != null)
                {
                    sec["defender_enabled"] = Bool(mp["AntivirusEnabled"]);
                    sec["realtime_protection"] = Bool(mp["RealTimeProtectionEnabled"]);
                    sec["antivirus_signature_date"] = CimDate(mp["AntivirusSignatureLastUpdated"])?.ToString("yyyy-MM-dd", Inv);
                    sec["antispyware_enabled"] = Bool(mp["AntispywareEnabled"]);
                    sec["defender_mode"] = Str(mp["AMRunningMode"]);
                }
            }
            catch (Exception ex) { Note("Windows Defender", ex); }

            // Third-party antivirus registered with Windows Security Center.
            try
            {
                sec["antivirus_products"] = Wmi(@"root\SecurityCenter2", "SELECT displayName, productState FROM AntiVirusProduct")
                    .Select(a =>
                    {
                        var state = Lng(a["productState"]) ?? 0;
                        return (object)new Dictionary<string, object>
                        {
                            ["name"] = Str(a["displayName"]),
                            ["enabled"] = ((state >> 12) & 0xF) == 1,
                            ["up_to_date"] = ((state >> 4) & 0xF) == 0,
                        };
                    })
                    .ToList();
            }
            catch (Exception ex) { Note("Antivirus installés", ex); }

            try
            {
                var policyType = Type.GetTypeFromProgID("HNetCfg.FwPolicy2");
                var policy = Activator.CreateInstance(policyType);
                try
                {
                    bool? Enabled(int profile)
                    {
                        try { return (bool)policyType.InvokeMember("FirewallEnabled", BindingFlags.GetProperty, null, policy, new object[] { profile }); }
                        catch { return null; }
                    }
                    sec["firewall_domain"] = Enabled(1);
                    sec["firewall_private"] = Enabled(2);
                    sec["firewall_public"] = Enabled(4);
                }
                finally { Marshal.ReleaseComObject(policy); }
            }
            catch (Exception ex) { Note("Pare-feu", ex); }

            var lua = RegValue(RegistryHive.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "EnableLUA");
            sec["uac_enabled"] = lua is int luaValue ? luaValue != 0 : (bool?)null;
            var secureBoot = RegValue(RegistryHive.LocalMachine, @"SYSTEM\CurrentControlSet\Control\SecureBoot\State", "UEFISecureBootEnabled");
            sec["secure_boot"] = secureBoot is int sbValue ? sbValue != 0 : (bool?)null;
            return sec;
        }

        Dictionary<string, object> CollectUpdates()
        {
            var hotfixes = Wmi(@"root\cimv2", "SELECT HotFixID, Description, InstalledOn FROM Win32_QuickFixEngineering")
                .Select(f => new { Id = Str(f["HotFixID"]), Description = Str(f["Description"]), Date = ParseHotfixDate(Str(f["InstalledOn"])) })
                .OrderByDescending(f => f.Date ?? DateTime.MinValue)
                .Take(5)
                .Select(f => (object)new Dictionary<string, object>
                {
                    ["id"] = f.Id,
                    ["description"] = f.Description,
                    ["installed_on"] = f.Date?.ToString("yyyy-MM-dd", Inv) ?? "?",
                })
                .ToList();

            var rebootPending =
                KeyExists(RegistryHive.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired") ||
                KeyExists(RegistryHive.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending");

            return new Dictionary<string, object>
            {
                ["last_hotfixes"] = hotfixes,
                ["reboot_pending"] = rebootPending,
            };
        }

        List<object> CollectTemperatures()
        {
            // ACPI thermal zones: usually requires admin rights, often absent on
            // laptops. Zones below 15 °C are placeholder values, not sensors.
            return Wmi(@"root\wmi", "SELECT InstanceName, CurrentTemperature FROM MSAcpi_ThermalZoneTemperature")
                .Select(t => new { Instance = Str(t["InstanceName"]), Celsius = (Dbl(t["CurrentTemperature"]) ?? 0) / 10 - 273.15 })
                .Where(t => t.Celsius >= 15 && t.Celsius < 150)
                .Select(t => (object)new Dictionary<string, object> { ["instance"] = t.Instance, ["temp_celsius"] = R1(t.Celsius) })
                .ToList();
        }

        Dictionary<string, object> CollectStability()
        {
            const long day = 86400000, week = 7 * day;

            // Unexpected shutdowns (Kernel-Power 41) and blue screens (BugCheck 1001).
            var crashes = ReadEvents("System",
                "*[System[((EventID=41 and Provider[@Name='Microsoft-Windows-Kernel-Power']) or " +
                "(EventID=1001 and (Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting'] or Provider[@Name='BugCheck']))) " +
                "and TimeCreated[timediff(@SystemTime) <= " + week + "]]]", 10, withMessage: true)
                .Select(e => (object)new Dictionary<string, object> { ["time"] = e.Time, ["id"] = e.Id, ["message"] = e.Message })
                .ToList();

            var errorsLastDay = "*[System[(Level=1 or Level=2) and TimeCreated[timediff(@SystemTime) <= " + day + "]]]";
            var critical = CountEvents("System", errorsLastDay, 100);
            critical += CountEvents("Application", errorsLastDay, 100 - critical);

            var samples = ReadEvents("System", "*[System[Level=2 and TimeCreated[timediff(@SystemTime) <= " + day + "]]]", 5, withMessage: true)
                .Select(e => (object)new Dictionary<string, object> { ["id"] = e.Id, ["source"] = e.Source, ["time"] = e.Time, ["message"] = e.Message })
                .ToList();

            // Programs that crashed (Application Error 1000), most frequent first.
            var appCrashes = ReadEvents("Application",
                "*[System[EventID=1000 and Provider[@Name='Application Error'] and TimeCreated[timediff(@SystemTime) <= " + week + "]]]", 200, withMessage: false)
                .Where(e => !string.IsNullOrEmpty(e.FirstProperty))
                .GroupBy(e => e.FirstProperty, StringComparer.OrdinalIgnoreCase)
                .OrderByDescending(g => g.Count())
                .Take(5)
                .Select(g => (object)new Dictionary<string, object> { ["app"] = g.Key, ["count"] = g.Count() })
                .ToList();

            return new Dictionary<string, object>
            {
                ["bsod_last_7days"] = crashes,
                ["bsod_count"] = crashes.Count,
                ["critical_24h"] = critical,
                ["samples"] = samples,
                ["app_crashes_7days"] = appCrashes,
            };
        }

        Dictionary<string, object> CollectPerformance()
        {
            // Raw disk counters sampled 1 s apart (WMI class names are not
            // localized, unlike Get-Counter paths on a French Windows).
            const string diskQuery = "SELECT PercentDiskTime, PercentDiskTime_Base, CurrentDiskQueueLength FROM Win32_PerfRawData_PerfDisk_PhysicalDisk WHERE Name='_Total'";

            var perf = new Dictionary<string, object>
            {
                ["cpu_pct"] = cpuPercent.HasValue ? R1(cpuPercent.Value) : null,
                ["ram_used_pct"] = ramTotalKb > 0 ? R1((1 - ramFreeKb / ramTotalKb) * 100) : null,
                ["pagefile_used_pct"] = pageTotalKb > 0 ? R1((pageTotalKb - pageFreeKb) / pageTotalKb * 100) : 0d,
            };

            try
            {
                var before = Wmi(@"root\cimv2", diskQuery).First();
                Thread.Sleep(1000);
                var after = Wmi(@"root\cimv2", diskQuery).First();

                var busy = (Dbl(after["PercentDiskTime"]) ?? 0) - (Dbl(before["PercentDiskTime"]) ?? 0);
                var span = (Dbl(after["PercentDiskTime_Base"]) ?? 0) - (Dbl(before["PercentDiskTime_Base"]) ?? 0);
                if (span > 0) perf["disk_pct_busy"] = R1(Clamp(busy / span * 100));
                perf["disk_queue"] = Dbl(after["CurrentDiskQueueLength"]);
            }
            catch (Exception ex) { Note("Activité disque", ex); }

            return perf;
        }

        List<object> CollectProcesses()
        {
            var processes = Process.GetProcesses();
            try
            {
                return processes
                    .Select(p => { try { return new { Process = p, Memory = p.WorkingSet64 }; } catch { return null; } })
                    .Where(p => p != null)
                    .OrderByDescending(p => p.Memory)
                    .Take(8)
                    .Select(p =>
                    {
                        double? cpuSeconds = null;
                        try { cpuSeconds = Math.Round(p.Process.TotalProcessorTime.TotalSeconds, 1); } catch { }
                        return (object)new Dictionary<string, object>
                        {
                            ["name"] = p.Process.ProcessName,
                            ["ram_mb"] = Math.Round(p.Memory / (1024d * 1024)),
                            ["cpu"] = cpuSeconds,
                            ["pid"] = p.Process.Id,
                        };
                    })
                    .ToList();
            }
            finally
            {
                foreach (var p in processes) p.Dispose();
            }
        }

        List<object> CollectStartup()
        {
            const string run = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";
            const string approved = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\";
            var entries = new List<string>();

            entries.AddRange(ValueNames(RegistryHive.LocalMachine, run, RegistryView.Registry64));
            entries.AddRange(ValueNames(RegistryHive.CurrentUser, run, RegistryView.Registry64));
            entries.AddRange(ValueNames(RegistryHive.LocalMachine, run, RegistryView.Registry32));

            foreach (var folder in new[] { Environment.SpecialFolder.Startup, Environment.SpecialFolder.CommonStartup })
            {
                try
                {
                    var path = Environment.GetFolderPath(folder);
                    if (Directory.Exists(path))
                        entries.AddRange(Directory.GetFiles(path)
                            .Select(Path.GetFileName)
                            .Where(f => !f.Equals("desktop.ini", StringComparison.OrdinalIgnoreCase)));
                }
                catch { }
            }

            // Entries switched off in Task Manager stay in the Run keys; Windows
            // records them under StartupApproved with an odd first byte.
            var disabled = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
                foreach (var sub in new[] { "Run", "Run32", "StartupFolder" })
                    foreach (var pair in Values(hive, approved + sub))
                        if (pair.Value is byte[] flags && flags.Length > 0 && (flags[0] & 1) == 1)
                            disabled.Add(pair.Key);

            return entries
                .Where(e => !string.IsNullOrWhiteSpace(e) && !disabled.Contains(e))
                .Select(e => e.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase) ? e.Substring(0, e.Length - 4) : e)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(30)
                .Cast<object>()
                .ToList();
        }

        static readonly Regex[] SoftwareNoise =
        {
            new Regex("^Microsoft|^Windows SDK|^Windows Desktop|^Universal CRT|^WinRT|^vs_|^vcpp_|^KB[0-9]|^Update for ", RegexOptions.IgnoreCase),
            new Regex("Add to Path|Core Interpreter|Development Libraries|pip Bootstrap|Standard Library|Tcl/Tk Support|Test Suite", RegexOptions.IgnoreCase),
            new Regex(@"Python Launcher|Python [0-9]+\.[0-9]+ (Add|Core|Dev|Doc|Exe|pip|Std|Tcl|Test)", RegexOptions.IgnoreCase),
            new Regex(@"AppHost Pack|Targeting Pack|Toolset|Templates [0-9]|Host FX Resolver|Host - [0-9]|Runtime - [0-9]", RegexOptions.IgnoreCase),
            new Regex(@"Workload\.(Emscripten|Mono|Maui|iOS|tvOS|Android|MacCatalyst|macOS)|Manifest-[0-9]|SDK\.[A-Z]", RegexOptions.IgnoreCase),
            new Regex(@"Redistributable.*- [0-9]{2}\.[0-9]", RegexOptions.IgnoreCase),
        };

        List<object> CollectSoftware()
        {
            // Same filtering as diag.ps1: Microsoft components, SDK/runtime parts
            // and updates are left out to keep the list readable.
            const string uninstall = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var software = new List<Dictionary<string, object>>();

            var sources = new[]
            {
                (RegistryHive.LocalMachine, RegistryView.Registry64),
                (RegistryHive.LocalMachine, RegistryView.Registry32),
                (RegistryHive.CurrentUser, RegistryView.Registry64),
            };

            foreach (var (hive, view) in sources)
            {
                using (var root = OpenKey(hive, uninstall, view))
                {
                    if (root == null) continue;
                    foreach (var subName in root.GetSubKeyNames())
                    {
                        try
                        {
                            using (var k = root.OpenSubKey(subName))
                            {
                                var name = (k?.GetValue("DisplayName") as string)?.Trim();
                                if (string.IsNullOrEmpty(name)) continue;
                                if (k.GetValue("SystemComponent") is int sc && sc == 1) continue;
                                if (k.GetValue("ParentKeyName") != null) continue;
                                var publisher = (k.GetValue("Publisher") as string)?.Trim();
                                if (publisher != null && Regex.IsMatch(publisher, "^Microsoft|^Windows", RegexOptions.IgnoreCase)) continue;
                                if (SoftwareNoise.Any(r => r.IsMatch(name))) continue;

                                var version = (k.GetValue("DisplayVersion") as string)?.Trim();
                                if (!seen.Add(name + "|" + version)) continue;

                                var sizeKb = Dbl(k.GetValue("EstimatedSize"));
                                software.Add(new Dictionary<string, object>
                                {
                                    ["name"] = name,
                                    ["version"] = version,
                                    ["publisher"] = publisher,
                                    ["install_date"] = k.GetValue("InstallDate") as string,
                                    ["size_mb"] = sizeKb.HasValue ? R1(sizeKb.Value / 1024) : null,
                                });
                            }
                        }
                        catch { }
                    }
                }
            }

            return software
                .OrderBy(s => (string)s["name"], StringComparer.OrdinalIgnoreCase)
                .Cast<object>()
                .ToList();
        }

        // ── WMI, registry and event log helpers ─────────────────────────────

        static List<Dictionary<string, object>> Wmi(string scope, string query)
        {
            var options = new EnumerationOptions { Timeout = TimeSpan.FromSeconds(20), ReturnImmediately = true, Rewindable = false };
            var rows = new List<Dictionary<string, object>>();
            using (var searcher = new ManagementObjectSearcher(new ManagementScope(scope), new ObjectQuery(query), options))
            using (var results = searcher.Get())
            {
                foreach (ManagementBaseObject item in results)
                    using (item) rows.Add(ToRow(item));
            }
            return rows;
        }

        static Dictionary<string, object> ToRow(ManagementBaseObject item)
        {
            var row = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            foreach (PropertyData property in item.Properties) row[property.Name] = property.Value;
            return row;
        }

        static bool IsElevated()
        {
            using (var identity = System.Security.Principal.WindowsIdentity.GetCurrent())
                return new System.Security.Principal.WindowsPrincipal(identity).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetSystemTimes(out long idleTime, out long kernelTime, out long userTime);

        static double? MeasureCpuPercent(int sampleMs)
        {
            if (!GetSystemTimes(out var idle1, out var kernel1, out var user1)) return null;
            Thread.Sleep(sampleMs);
            if (!GetSystemTimes(out var idle2, out var kernel2, out var user2)) return null;
            // Kernel time includes idle time.
            double idle = idle2 - idle1, total = (kernel2 - kernel1) + (user2 - user1);
            return total > 0 ? Clamp((1 - idle / total) * 100) : (double?)null;
        }

        static RegistryKey OpenKey(RegistryHive hive, string path, RegistryView view = RegistryView.Registry64)
        {
            try
            {
                using (var root = RegistryKey.OpenBaseKey(hive, view)) return root.OpenSubKey(path);
            }
            catch { return null; }
        }

        static object RegValue(RegistryHive hive, string path, string name)
        {
            using (var key = OpenKey(hive, path)) return key?.GetValue(name);
        }

        static bool KeyExists(RegistryHive hive, string path)
        {
            using (var key = OpenKey(hive, path)) return key != null;
        }

        static IEnumerable<string> ValueNames(RegistryHive hive, string path, RegistryView view)
        {
            using (var key = OpenKey(hive, path, view))
                return key?.GetValueNames().Where(n => n.Length > 0).ToList() ?? new List<string>();
        }

        static IEnumerable<KeyValuePair<string, object>> Values(RegistryHive hive, string path)
        {
            using (var key = OpenKey(hive, path))
            {
                if (key == null) return Enumerable.Empty<KeyValuePair<string, object>>();
                return key.GetValueNames().Select(n => new KeyValuePair<string, object>(n, key.GetValue(n))).ToList();
            }
        }

        static Dictionary<string, double> ReadVramFromRegistry()
        {
            const string displayClass = @"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
            var result = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
            using (var root = OpenKey(RegistryHive.LocalMachine, displayClass))
            {
                if (root == null) return result;
                foreach (var sub in root.GetSubKeyNames().Where(s => Regex.IsMatch(s, @"^\d{4}$")))
                {
                    try
                    {
                        using (var k = root.OpenSubKey(sub))
                        {
                            var description = k?.GetValue("DriverDesc") as string;
                            var size = k?.GetValue("HardwareInformation.qwMemorySize");
                            if (description == null || size == null) continue;
                            var bytes = size is byte[] raw && raw.Length >= 8 ? BitConverter.ToInt64(raw, 0) : Convert.ToDouble(size, Inv);
                            if (bytes > 0) result[description] = bytes;
                        }
                    }
                    catch { }
                }
            }
            return result;
        }

        sealed class EventInfo
        {
            public long Id;
            public string Source, Time, Message, FirstProperty;
        }

        static List<EventInfo> ReadEvents(string log, string xpath, int max, bool withMessage)
        {
            var events = new List<EventInfo>();
            var query = new EventLogQuery(log, PathType.LogName, xpath) { ReverseDirection = true };
            using (var reader = new EventLogReader(query))
            {
                while (events.Count < max)
                {
                    using (var record = reader.ReadEvent())
                    {
                        if (record == null) break;
                        string message = null, firstProperty = null;
                        if (withMessage)
                        {
                            try { message = FirstLine(record.FormatDescription()); } catch { }
                        }
                        try { firstProperty = record.Properties.Count > 0 ? Convert.ToString(record.Properties[0].Value, Inv) : null; } catch { }
                        events.Add(new EventInfo
                        {
                            Id = record.Id,
                            Source = record.ProviderName,
                            Time = record.TimeCreated?.ToString("yyyy-MM-ddTHH:mm:ss", Inv),
                            Message = message ?? "",
                            FirstProperty = firstProperty,
                        });
                    }
                }
            }
            return events;
        }

        static int CountEvents(string log, string xpath, int max)
        {
            if (max <= 0) return 0;
            var count = 0;
            var query = new EventLogQuery(log, PathType.LogName, xpath) { ReverseDirection = true };
            using (var reader = new EventLogReader(query))
            {
                while (count < max)
                {
                    using (var record = reader.ReadEvent())
                    {
                        if (record == null) break;
                        count++;
                    }
                }
            }
            return count;
        }

        static bool HttpReachable(string url)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "HEAD";
                request.Timeout = 5000;
                using (request.GetResponse()) return true;
            }
            catch (WebException ex) when (ex.Response != null)
            {
                ex.Response.Dispose();
                return true;
            }
            catch { return false; }
        }

        // ── Conversions ─────────────────────────────────────────────────────

        void Note(string section, Exception ex)
        {
            string reason;
            if (ex is UnauthorizedAccessException || ex is ManagementException { ErrorCode: ManagementStatus.AccessDenied })
                reason = "accès refusé (droits administrateur requis)";
            else if (ex is ManagementException { ErrorCode: ManagementStatus.InvalidNamespace or ManagementStatus.InvalidClass or ManagementStatus.NotSupported })
                reason = "non disponible sur ce PC";
            else if (ex is EventLogNotFoundException)
                reason = "journal introuvable";
            else
                reason = ex.GetType().Name + " : " + Truncate(ex.Message, 140);
            lock (notes) notes.Add(section + " : " + reason);
        }

        static string FirstLine(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return "";
            var line = text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim() ?? "";
            return Truncate(line, 300);
        }

        static string Truncate(string s, int max) => s == null || s.Length <= max ? s : s.Substring(0, max - 1) + "…";

        static DateTime? ParseHotfixDate(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            if (DateTime.TryParse(value, Inv, DateTimeStyles.None, out var date)) return date;
            // Some entries store a FILETIME as hexadecimal.
            try { return DateTime.FromFileTimeUtc(long.Parse(value, NumberStyles.HexNumber, Inv)).ToLocalTime(); }
            catch { return null; }
        }

        static double Clamp(double value) => Math.Max(0, Math.Min(100, value));
        static object R1(double value) => Math.Round(value, 1);
        static object R0(double value) => Math.Round(value);

        static string Str(object v) => v == null ? null : Convert.ToString(v, Inv)?.Trim();

        static double? Dbl(object v)
        {
            if (v == null) return null;
            try { return Convert.ToDouble(v, Inv); } catch { return null; }
        }

        static long? Lng(object v)
        {
            if (v == null) return null;
            try { return Convert.ToInt64(v, Inv); } catch { return null; }
        }

        static int? Int(object v)
        {
            if (v == null) return null;
            try { return Convert.ToInt32(v, Inv); } catch { return null; }
        }

        static bool? Bool(object v)
        {
            if (v == null) return null;
            if (v is bool b) return b;
            try { return Convert.ToInt64(v, Inv) != 0; } catch { return null; }
        }

        static DateTime? CimDate(object v)
        {
            var text = v as string;
            if (string.IsNullOrEmpty(text)) return null;
            try { return ManagementDateTimeConverter.ToDateTime(text); } catch { return null; }
        }

        static string MediaTypeName(int? value) => value switch
        {
            3 => "HDD",
            4 => "SSD",
            5 => "SCM",
            _ => "Unspecified",
        };

        static string BusTypeName(int? value) => value switch
        {
            1 => "SCSI", 2 => "ATAPI", 3 => "ATA", 4 => "1394", 5 => "SSA", 6 => "Fibre Channel",
            7 => "USB", 8 => "RAID", 9 => "iSCSI", 10 => "SAS", 11 => "SATA", 12 => "SD", 13 => "MMC",
            14 => "Virtual", 15 => "File Backed Virtual", 16 => "Storage Spaces", 17 => "NVMe", 18 => "SCM", 19 => "UFS",
            _ => "Unknown",
        };

        static string HealthName(int? value) => value switch
        {
            0 => "Healthy",
            1 => "Warning",
            2 => "Unhealthy",
            _ => "Unknown",
        };

        static string OperationalStatusName(object value)
        {
            if (!(value is ushort[] codes) || codes.Length == 0) return null;
            return string.Join(", ", codes.Select(code => code switch
            {
                2 => "OK",
                3 => "Degraded",
                4 => "Stressed",
                5 => "Predictive Failure",
                6 => "Error",
                7 => "Non-Recoverable Error",
                10 => "Stopped",
                12 => "No Contact",
                13 => "Lost Communication",
                0xD010 => "Online",
                0xD011 => "Not Ready",
                0xD012 => "No Media",
                0xD013 => "Offline",
                0xD014 => "Failed",
                _ => code.ToString(Inv),
            }));
        }
    }
}
