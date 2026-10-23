// Source-owned Windows AppContainer launcher. Compile with the OS .NET Framework csc.
// The helper is trusted; only the requested child enters the constrained token/job.
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;
using System.Diagnostics;
using System.Threading;
using System.Security.Cryptography;

class AppContainerHost {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct SI {public int cb;public string reserved,desktop,title;public int x,y,xs,ys,xc,yc,fill,flags;public short show,reserved2;public IntPtr reservedPtr,stdin,stdout,stderr;}
 [StructLayout(LayoutKind.Sequential)]struct SIX {public SI si;public IntPtr attrs;}
 [StructLayout(LayoutKind.Sequential)]struct PI {public IntPtr process,thread;public int pid,tid;}
 [StructLayout(LayoutKind.Sequential)]struct CAP {public IntPtr sid,capabilities;public uint count,reserved;}
 [StructLayout(LayoutKind.Sequential)]struct SIDATTR {public IntPtr sid;public uint attributes;}
 [StructLayout(LayoutKind.Sequential)]struct IO_COUNTERS {public ulong r,w,o,rb,wb,ob;}
 [StructLayout(LayoutKind.Sequential)]struct BASIC_LIMIT {public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)]struct JOB_LIMIT {public BASIC_LIMIT basic;public IO_COUNTERS io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
 [StructLayout(LayoutKind.Sequential)]struct JOB_ACCOUNTING {public long user,kernel,periodUser,periodKernel;public uint pageFaults,totalProcesses,activeProcesses,terminated;}
 [StructLayout(LayoutKind.Sequential)]struct CPU_RATE {public uint flags,rate;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct PROCESS_ENTRY {public uint size,usage,pid;public UIntPtr heap;public uint module,threads,parent;public int priority;public uint flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string name;}
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool Process32FirstW(IntPtr snapshot,ref PROCESS_ENTRY entry);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool Process32NextW(IntPtr snapshot,ref PROCESS_ENTRY entry);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)]static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)]static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)]static extern int DeleteAppContainerProfile(string name);
 [DllImport("advapi32.dll")]static extern IntPtr FreeSid(IntPtr sid);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr information,int size,out int returned);
 [DllImport("advapi32.dll")]static extern bool EqualSid(IntPtr first,IntPtr second);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attr,IntPtr value,IntPtr size,IntPtr old,IntPtr returned);
 [DllImport("kernel32.dll")]static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX startup,out PI pi);
 [DllImport("kernel32.dll")]static extern IntPtr GetStdHandle(int handle);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
 [DllImport("kernel32.dll")]static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr p,uint timeout);
 [DllImport("kernel32.dll")]static extern bool GetExitCodeProcess(IntPtr p,out uint code);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr p);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateJobObject(IntPtr attrs,string name);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr value,uint size);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool QueryInformationJobObject(IntPtr job,int kind,out JOB_ACCOUNTING value,uint size,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr process,uint code);
 static JavaScriptSerializer json=new JavaScriptSerializer{MaxJsonLength=8*1024*1024};
 static void Check(bool ok,string op){if(!ok)throw new Exception(op+" failed (Win32 "+Marshal.GetLastWin32Error()+")");}
 static string Text(Dictionary<string,object> obj,string key){return Convert.ToString(obj[key]);}
 static string Quote(string value){var b=new StringBuilder("\"");int slash=0;foreach(char c in value){if(c=='\\'){slash++;continue;}if(c=='"'){b.Append('\\',slash*2+1);b.Append(c);slash=0;continue;}b.Append('\\',slash);slash=0;b.Append(c);}b.Append('\\',slash*2);return b.Append('"').ToString();}
 static void Save(string file,object value){string temp=file+"."+Guid.NewGuid().ToString("N")+".tmp";File.WriteAllText(temp,json.Serialize(value),new UTF8Encoding(false));try{for(int retry=0;;retry++){try{if(File.Exists(file))File.Replace(temp,file,null);else File.Move(temp,file);break;}catch(IOException){if(retry>=100)throw;Thread.Sleep(10);}}}finally{if(File.Exists(temp))File.Delete(temp);}}
 static string StatePath(string manifest){return Path.Combine(Path.GetDirectoryName(manifest),"state.json");}
 static Dictionary<string,object> Load(string file){using(var stream=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))using(var reader=new StreamReader(stream,Encoding.UTF8))return json.Deserialize<Dictionary<string,object>>(reader.ReadToEnd());}
 static bool Exists(string root){return Directory.Exists(root)||File.Exists(root);}
 static void NoLink(string root){if(Exists(root) && (File.GetAttributes(root)&FileAttributes.ReparsePoint)!=0)throw new Exception("Refuse ACL operation on a linked root");}
 static string MutexName(string root){using(var sha=SHA256.Create()){return "Local\\Foundation.Agent.Acl."+BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToUpperInvariant()))).Replace("-","");}}
 static void Grant(Dictionary<string,object> item,SecurityIdentifier sid,bool remove){
  string root=Path.GetFullPath(Text(item,"path"));if(!Exists(root))return;NoLink(root);
  using(var mutex=new Mutex(false,MutexName(root))){bool held=false;try{try{held=mutex.WaitOne(15000);}catch(AbandonedMutexException){held=true;}if(!held)throw new Exception("Workspace ACL lock timed out");
   bool directory=Directory.Exists(root);FileSystemSecurity acl=directory?(FileSystemSecurity)Directory.GetAccessControl(root):File.GetAccessControl(root);
   if(remove){foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,false,typeof(SecurityIdentifier)))if(rule.IdentityReference.Equals(sid))acl.RemoveAccessRuleSpecific(rule);}
   else if(!directory)acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.ReadAndExecute,AccessControlType.Allow));
   else if(Convert.ToBoolean(item["readOnly"]))acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.ReadAndExecute,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
   else {
    // Root replacement is forbidden. Children may be changed/deleted inside the granted tree.
    acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.ReadAndExecute|FileSystemRights.Write|FileSystemRights.DeleteSubdirectoriesAndFiles,AccessControlType.Allow));
    acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.Modify,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.InheritOnly,AccessControlType.Allow));
   }
   if(directory)Directory.SetAccessControl(root,(DirectorySecurity)acl);else File.SetAccessControl(root,(FileSecurity)acl);
  }finally{if(held)mutex.ReleaseMutex();}}
 }
 static void SetJob<T>(IntPtr job,int kind,T value){IntPtr data=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T)));try{Marshal.StructureToPtr(value,data,false);Check(SetInformationJobObject(job,kind,data,(uint)Marshal.SizeOf(typeof(T))),"Job limits");}finally{Marshal.FreeHGlobal(data);}}
 static void StopJob(IntPtr job){if(job==IntPtr.Zero)return;Check(TerminateJobObject(job,1),"Terminate sandbox job");var until=DateTime.UtcNow.AddSeconds(8);while(true){JOB_ACCOUNTING count;Check(QueryInformationJobObject(job,1,out count,(uint)Marshal.SizeOf(typeof(JOB_ACCOUNTING)),IntPtr.Zero),"Query sandbox job");if(count.activeProcesses==0)return;if(DateTime.UtcNow>until)throw new Exception("Sandbox job termination unconfirmed");Thread.Sleep(20);}}
 static void VerifyToken(IntPtr process,IntPtr sid){IntPtr token=IntPtr.Zero,buffer=IntPtr.Zero;try{Check(OpenProcessToken(process,8,out token),"Open child token");buffer=Marshal.AllocHGlobal(256);int returned;Check(GetTokenInformation(token,29,buffer,256,out returned),"Read AppContainer token");if(Marshal.ReadInt32(buffer)!=1)throw new Exception("Child is not an AppContainer");Check(GetTokenInformation(token,31,buffer,256,out returned),"Read package SID");if(!EqualSid(sid,Marshal.ReadIntPtr(buffer)))throw new Exception("Child package SID mismatch");}finally{if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);if(token!=IntPtr.Zero)CloseHandle(token);}}
 static bool OwnerAlive(Dictionary<string,object> state){try{var process=Process.GetProcessById(Convert.ToInt32(state["helperPid"]));return process.StartTime.ToUniversalTime().Ticks.ToString()==Text(state,"helperBirth");}catch{return false;}}
 static Process ParentOwner(){
  IntPtr snapshot=CreateToolhelp32Snapshot(2,0);Check(snapshot!=new IntPtr(-1),"Read sandbox owner snapshot");
  try{var entry=new PROCESS_ENTRY();entry.size=(uint)Marshal.SizeOf(typeof(PROCESS_ENTRY));Check(Process32FirstW(snapshot,ref entry),"Read sandbox owner");do{if(entry.pid==(uint)Process.GetCurrentProcess().Id){var owner=Process.GetProcessById((int)entry.parent);if(owner.StartTime>Process.GetCurrentProcess().StartTime || WaitForSingleObject(owner.Handle,0)!=258){owner.Dispose();throw new Exception("Sandbox owner exited before launch");}return owner;}}while(Process32NextW(snapshot,ref entry));throw new Exception("Sandbox owner identity unavailable");}finally{CloseHandle(snapshot);}
 }
 static void Validate(Dictionary<string,object> m){string profile=Text(m,"profile");if(!System.Text.RegularExpressions.Regex.IsMatch(profile,"^foundation\\.agent\\.[a-f0-9]{32}$"))throw new Exception("Invalid sandbox profile");if(Text(m,"job")!="Local\\Foundation.Agent."+profile)throw new Exception("Invalid sandbox job identity");}
 static void RemoveStaged(string file){
  var deadline=DateTime.UtcNow.AddSeconds(8);
  while(true){
   try{if(File.Exists(file))File.Delete(file);else if(Directory.Exists(file)){NoLink(file);Directory.Delete(file,true);}return;}
   catch(IOException error){int code=error.HResult&0xffff;if((code!=32&&code!=33)||DateTime.UtcNow>=deadline)throw;Thread.Sleep(50);}
  }
 }
 static bool Cleanup(string manifest,bool orphan){
  var m=Load(manifest);Validate(m);string stateFile=StatePath(manifest);var state=File.Exists(stateFile)?Load(stateFile):new Dictionary<string,object>();
  if(state.ContainsKey("cleanupConfirmed") && Convert.ToBoolean(state["cleanupConfirmed"]))return true;
  if(orphan && state.ContainsKey("helperPid") && OwnerAlive(state))return false;
  IntPtr job=OpenJobObject(8|4,false,Text(m,"job"));
  if(job==IntPtr.Zero && Marshal.GetLastWin32Error()!=2)throw new Exception("Cannot confirm sandbox job absence ("+Marshal.GetLastWin32Error()+")");
  try{StopJob(job);}finally{if(job!=IntPtr.Zero)CloseHandle(job);}
  if(state.ContainsKey("helperPid") && Convert.ToInt32(state["helperPid"])!=Process.GetCurrentProcess().Id) {
   var deadline=DateTime.UtcNow.AddSeconds(8);
   while(OwnerAlive(state)) {
    if(File.Exists(stateFile)){var latest=Load(stateFile);if(latest.ContainsKey("cleanupConfirmed") && Convert.ToBoolean(latest["cleanupConfirmed"]))return true;}
    if(DateTime.UtcNow>deadline)throw new Exception("Sandbox launcher termination unconfirmed");Thread.Sleep(20);
   }
   if(File.Exists(stateFile))state=Load(stateFile);
  }
  IntPtr sid;int hr=DeriveAppContainerSidFromAppContainerName(Text(m,"profile"),out sid);if(hr!=0)throw new Exception("Cannot derive cleanup package SID");
  try{var identity=new SecurityIdentifier(sid);foreach(Dictionary<string,object> root in (IEnumerable)m["grants"])Grant(root,identity,true);}finally{FreeSid(sid);}
  hr=DeleteAppContainerProfile(Text(m,"profile"));if(hr!=0 && hr!=unchecked((int)0x80070002) && hr!=unchecked((int)0x80070003))throw new Exception("AppContainer profile cleanup failed: "+hr);
  foreach(string name in new[]{"request.json","runtime"})RemoveStaged(Path.Combine(Path.GetDirectoryName(manifest),name));
  state["phase"]="closed";state["cleanupConfirmed"]=true;state["closedAt"]=DateTime.UtcNow.ToString("o");Save(stateFile,state);return true;
 }
 static int Launch(string manifest,string request){
  var m=Load(manifest);Validate(m);var cfg=Load(request);File.Delete(request);
  var state=new Dictionary<string,object>{{"profile",m["profile"]},{"phase","starting"},{"helperPid",Process.GetCurrentProcess().Id},{"helperBirth",Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString()},{"network",cfg["network"]}};Save(StatePath(manifest),state);
  IntPtr sid=IntPtr.Zero,attrs=IntPtr.Zero,cap=IntPtr.Zero,capSid=IntPtr.Zero,capArray=IntPtr.Zero,handles=IntPtr.Zero,env=IntPtr.Zero,job=IntPtr.Zero;PI pi=new PI();int exit=125;Process owner=null;
  try {
   owner=ParentOwner();state["ownerPid"]=owner.Id;state["ownerBirth"]=owner.StartTime.ToUniversalTime().Ticks.ToString();
   int hr=CreateAppContainerProfile(Text(m,"profile"),"Agent isolated execution","Foundation single-user process",IntPtr.Zero,0,out sid);if(hr!=0)throw new Exception("Create AppContainer profile failed: "+hr);
   var identity=new SecurityIdentifier(sid);foreach(Dictionary<string,object> root in (IEnumerable)m["grants"])Grant(root,identity,false);
   var security=new CAP{sid=sid};
   if(Text(cfg,"network")=="internet") {byte[] b=new byte[64];var s=new SecurityIdentifier("S-1-15-3-1");s.GetBinaryForm(b,0);capSid=Marshal.AllocHGlobal(s.BinaryLength);Marshal.Copy(b,0,capSid,s.BinaryLength);capArray=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SIDATTR)));Marshal.StructureToPtr(new SIDATTR{sid=capSid,attributes=4},capArray,false);security.capabilities=capArray;security.count=1;}
   cap=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CAP)));Marshal.StructureToPtr(security,cap,false);
   IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);attrs=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(attrs,2,0,ref size),"Create process attributes");
   Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20009),cap,new IntPtr(Marshal.SizeOf(typeof(CAP))),IntPtr.Zero,IntPtr.Zero),"Set AppContainer security");
   var startup=new SIX();startup.si.cb=Marshal.SizeOf(typeof(SIX));startup.attrs=attrs;startup.si.flags=0x100;startup.si.stdin=GetStdHandle(-10);startup.si.stdout=GetStdHandle(-11);startup.si.stderr=GetStdHandle(-12);
   handles=Marshal.AllocHGlobal(IntPtr.Size*3);var hs=new[]{startup.si.stdin,startup.si.stdout,startup.si.stderr};for(int i=0;i<3;i++){Check(SetHandleInformation(hs[i],1,1),"Inherit stdio handle");Marshal.WriteIntPtr(handles,i*IntPtr.Size,hs[i]);}
   Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"Limit inherited handles");
   var vars=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);foreach(var pair in (Dictionary<string,object>)cfg["env"])vars[pair.Key]=Convert.ToString(pair.Value);
   // Windows requires these profile inputs when constructing the new lowbox token.
   foreach(string name in new[]{"SystemRoot","USERPROFILE","LOCALAPPDATA","APPDATA","SystemDrive"})if(!vars.ContainsKey(name))vars[name]=Environment.GetEnvironmentVariable(name)??"";
   var block=new StringBuilder();foreach(var pair in vars)block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');block.Append('\0');env=Marshal.StringToHGlobalUni(block.ToString());
   string command=Text(cfg,"command");var cmd=new StringBuilder(Quote(command));foreach(object a in (IEnumerable)cfg["args"])cmd.Append(" ").Append(Quote(Convert.ToString(a)));
   job=CreateJobObject(IntPtr.Zero,Text(m,"job"));Check(job!=IntPtr.Zero,"Create sandbox job");if(Marshal.GetLastWin32Error()==183)throw new Exception("Sandbox job identity already exists");
   var limits=new JOB_LIMIT();limits.basic.flags=0x2000|0x8|0x100|0x200;limits.basic.active=Convert.ToUInt32(cfg["pidsLimit"]);limits.processMemory=new UIntPtr(Convert.ToUInt64(cfg["memoryMb"])*1024*1024);limits.jobMemory=limits.processMemory;SetJob(job,9,limits);
   SetJob(job,15,new CPU_RATE{flags=1|4,rate=(uint)Math.Max(1,Math.Min(10000,Convert.ToDouble(cfg["cpus"])/Environment.ProcessorCount*10000))});
   Check(CreateProcessW(command,cmd,IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|0x8000000|4,env,Text(cfg,"cwd"),ref startup,out pi),"Create isolated process");
   Check(AssignProcessToJobObject(job,pi.process),"Assign isolated process job");VerifyToken(pi.process,sid);
   state["phase"]="running";state["pid"]=pi.pid;state["osSandbox"]=true;state["verifiedPackageSid"]=identity.Value;state["startedAt"]=DateTime.UtcNow.ToString("o");Save(StatePath(manifest),state);
   if(WaitForSingleObject(owner.Handle,0)!=258)throw new Exception("Sandbox owner exited before resume");
   Check(ResumeThread(pi.thread)!=0xffffffff,"Resume isolated process");
   while(WaitForSingleObject(pi.process,100)==258){if(WaitForSingleObject(owner.Handle,0)!=258){StopJob(job);throw new Exception("Sandbox owner exited; child job terminated");}}
   uint code;Check(GetExitCodeProcess(pi.process,out code),"Read isolated exit");exit=unchecked((int)code);
   StopJob(job);state["phase"]="exited";state["exitCode"]=exit;Save(StatePath(manifest),state);
  } catch(Exception error){state["phase"]="failed";state["error"]=error.Message;Save(StatePath(manifest),state);Console.Error.WriteLine("Windows sandbox: "+error.Message);exit=125;}
  finally {
   if(pi.process!=IntPtr.Zero){TerminateProcess(pi.process,1);CloseHandle(pi.process);}if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(job!=IntPtr.Zero)CloseHandle(job);
   if(attrs!=IntPtr.Zero){DeleteProcThreadAttributeList(attrs);Marshal.FreeHGlobal(attrs);}foreach(IntPtr pointer in new[]{cap,capSid,capArray,handles,env})if(pointer!=IntPtr.Zero)Marshal.FreeHGlobal(pointer);if(sid!=IntPtr.Zero)FreeSid(sid);
   if(owner!=null)owner.Dispose();
   try{Cleanup(manifest,false);}catch(Exception error){Console.Error.WriteLine("Windows sandbox cleanup: "+error.Message);exit=125;}
  }
  return exit;
 }
 public static int Main(string[] args){try{Console.SetOut(new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false)){AutoFlush=true});Console.SetError(new StreamWriter(Console.OpenStandardError(),new UTF8Encoding(false)){AutoFlush=true});if(args.Length==3 && args[0]=="launch")return Launch(args[1],args[2]);if(args.Length==2 && (args[0]=="cleanup"||args[0]=="recover")){Cleanup(args[1],args[0]=="recover");return 0;}throw new Exception("Invalid trusted sandbox host command");}catch(Exception error){Console.Error.WriteLine("Windows sandbox: "+error.Message);return 125;}}
}
