// Foundation-maintained Windows ConPTY bridge. Build with the OS .NET Framework C# compiler.
// Transport: newline JSON on stdin/stdout; terminal data uses base64. No shell interpolation.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

class ConPtyHost {
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X,Y; public COORD(short x, short y) { X=x; Y=y; } }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string reserved,desktop,title; public int x,y,xs,ys,xc,yc,fill,flags;
    public short show,reserved2; public IntPtr reservedPtr,stdin,stdout,stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO si; public IntPtr attrs; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong r,w,o,rb,wb,ob; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long perProcess,perJob; public uint flags; public UIntPtr min,max; public uint active;
    public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,IntPtr attrs,int size);
  [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(COORD size,IntPtr input,IntPtr output,uint flags,out IntPtr handle);
  [DllImport("kernel32.dll")] static extern int ResizePseudoConsole(IntPtr handle,COORD size);
  [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr value,uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll")] static extern bool SetStdHandle(int handle,IntPtr value);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr handle,uint code);
  static object gate=new object();
  static JavaScriptSerializer json=new JavaScriptSerializer();
  static void Send(object value) { lock(gate) { Console.Out.WriteLine(json.Serialize(value)); Console.Out.Flush(); } }
  static void Check(bool ok,string op) { if(!ok) throw new Exception(op+": "+Marshal.GetLastWin32Error()); }
  static int Number(Dictionary<string,object> obj,string key,int fallback) { return obj.ContainsKey(key)?Convert.ToInt32(obj[key]):fallback; }
  static string Quote(string value) {
    StringBuilder b=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='\"') { b.Append('\\',slashes*2+1); b.Append(c); slashes=0; continue; }
      b.Append('\\',slashes); slashes=0; b.Append(c);
    }
    b.Append('\\',slashes*2); return b.Append('"').ToString();
  }
  public static int Main() {
    IntPtr pc=IntPtr.Zero,job=IntPtr.Zero,attrs=IntPtr.Zero,env=IntPtr.Zero;
    PROCESS_INFORMATION pi=new PROCESS_INFORMATION(); FileStream input=null,output=null;
    try {
      Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false);
      Dictionary<string,object> cfg=json.Deserialize<Dictionary<string,object>>(Console.ReadLine());
      IntPtr inRead,inWrite,outRead,outWrite;
      Check(CreatePipe(out inRead,out inWrite,IntPtr.Zero,0),"input pipe");
      Check(CreatePipe(out outRead,out outWrite,IntPtr.Zero,0),"output pipe");
      int result=CreatePseudoConsole(new COORD((short)Number(cfg,"cols",100),(short)Number(cfg,"rows",30)),inRead,outWrite,0,out pc);
      if(result!=0) throw new Exception("CreatePseudoConsole HRESULT "+result);
      CloseHandle(inRead); CloseHandle(outWrite);
      input=new FileStream(new SafeFileHandle(inWrite,true),FileAccess.Write);
      output=new FileStream(new SafeFileHandle(outRead,true),FileAccess.Read);
      // Drain before CreateProcess/ClosePseudoConsole: ConPTY can synchronously wait for its output reader.
      FileStream reader=output;
      Thread pump=new Thread(delegate() { try { byte[] data=new byte[8192]; int n; while((n=reader.Read(data,0,data.Length))>0) Send(new {type="data",data=Convert.ToBase64String(data,0,n)}); } catch {} });
      pump.IsBackground=true; pump.Start();
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
      attrs=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attrs,1,0,ref size),"attribute list");
      Check(UpdateProcThreadAttribute(attrs,0,(IntPtr)0x00020016,pc,(IntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero),"pseudoconsole attribute");
      STARTUPINFOEX startup=new STARTUPINFOEX(); startup.si.cb=Marshal.SizeOf(startup); startup.attrs=attrs;
      StringBuilder cmd=new StringBuilder(Quote((string)cfg["command"]));
      foreach(object arg in (System.Collections.IEnumerable)cfg["args"]) cmd.Append(" ").Append(Quote((string)arg));
      // The helper inherits only the explicitly filtered broker environment.
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"job");
      EXTENDED_LIMIT limit=new EXTENDED_LIMIT(); limit.basic.flags=0x2000|0x100|0x8;
      limit.basic.active=(uint)Number(cfg,"pidsLimit",128);
      limit.processMemory=(UIntPtr)((ulong)Number(cfg,"memoryMb",512)*1024*1024);
      IntPtr limits=Marshal.AllocHGlobal(Marshal.SizeOf(limit));
      try { Marshal.StructureToPtr(limit,limits,false); Check(SetInformationJobObject(job,9,limits,(uint)Marshal.SizeOf(limit)),"job limits"); }
      finally { Marshal.FreeHGlobal(limits); }
      // Windows may otherwise copy redirected helper handles into the client even with inherit=false.
      // Console streams above are already opened; clear only the OS startup handles around CreateProcess.
      IntPtr savedIn=GetStdHandle(-10), savedOut=GetStdHandle(-11), savedErr=GetStdHandle(-12);
      SetStdHandle(-10,IntPtr.Zero); SetStdHandle(-11,IntPtr.Zero); SetStdHandle(-12,IntPtr.Zero);
      try { Check(CreateProcessW(null,cmd,IntPtr.Zero,IntPtr.Zero,false,0x00080000|0x00000004,env,(string)cfg["cwd"],ref startup,out pi),"CreateProcess"); }
      finally { SetStdHandle(-10,savedIn); SetStdHandle(-11,savedOut); SetStdHandle(-12,savedErr); }
      if(!AssignProcessToJobObject(job,pi.process)) { TerminateProcess(pi.process,1); throw new Exception("AssignProcessToJobObject failed"); }
      Check(ResumeThread(pi.thread)!=0xffffffff,"ResumeThread"); CloseHandle(pi.thread); pi.thread=IntPtr.Zero;
      Send(new {type="ready",pid=pi.pid,backend="windows-conpty"});
      IntPtr processHandle=pi.process;
      Thread waiter=new Thread(delegate() { WaitForSingleObject(processHandle,0xffffffff); }); waiter.IsBackground=true; waiter.Start();
      FileStream writer=input; IntPtr console=pc,jobHandle=job;
      Thread controls=new Thread(delegate() {
        try { string line; while((line=Console.ReadLine())!=null) {
          Dictionary<string,object> request=json.Deserialize<Dictionary<string,object>>(line); string op=(string)request["op"];
          if(op=="write") { byte[] data=Convert.FromBase64String((string)request["data"]); writer.Write(data,0,data.Length); writer.Flush(); }
          else if(op=="resize") { int hr=ResizePseudoConsole(console,new COORD((short)Number(request,"cols",100),(short)Number(request,"rows",30))); if(hr!=0) Send(new {type="error",error="ResizePseudoConsole "+hr}); else Send(new {type="resized"}); }
          else if(op=="stop") { TerminateJobObject(jobHandle,1); return; }
        }
        TerminateJobObject(jobHandle,1);
        } catch { TerminateJobObject(jobHandle,1); }
      }); controls.IsBackground=true; controls.Start();
      waiter.Join(); uint code; GetExitCodeProcess(pi.process,out code);
      CloseHandle(job); job=IntPtr.Zero; ClosePseudoConsole(pc); pc=IntPtr.Zero;
      pump.Join(3000); Send(new {type="exit",exitCode=code}); return 0;
    } catch(Exception e) { Send(new {type="error",error=e.Message}); return 1; }
    finally {
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(pc!=IntPtr.Zero) ClosePseudoConsole(pc);
      if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
      if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread);
      if(attrs!=IntPtr.Zero) { DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs); }
      if(input!=null) input.Dispose(); if(output!=null) output.Dispose();
    }
  }
}
