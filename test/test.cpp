#include <cstdio>
#include <cstdlib>

#if _MSC_VER
#define __PRETTY_FUNCTION__ __FUNCSIG__
#endif

#define TESTFUNC(decl) virtual decl { printf("%s\n", __PRETTY_FUNCTION__); }

void *operator new(size_t size) {
  return malloc(size);
}

void operator delete(void *ptr) {
  free(ptr);
}

extern "C" void __cxa_pure_virtual() {
  printf("%s\n", __PRETTY_FUNCTION__);
}

struct COne {
  TESTFUNC( ~COne() )
  TESTFUNC( void One() )
  TESTFUNC( void Two() )
  TESTFUNC( void Three() )
  TESTFUNC( void Four() )
};

struct CTwo: public COne {
  TESTFUNC( void Two() )
  TESTFUNC( void Three(int) )
  TESTFUNC( void Three(float) )
  TESTFUNC( void Three(char) )
  TESTFUNC( void Five() )
};

struct CThree {
  TESTFUNC( void Six() )
  TESTFUNC( void Six(int) )
  TESTFUNC( void Six(unsigned) )
  TESTFUNC( void Seven() )
};

struct CFour: public CTwo, public CThree {
  TESTFUNC( void One() )
  TESTFUNC( void Two() )
  TESTFUNC( void Six() )
  TESTFUNC( void Six(int) )
  TESTFUNC( void Six(float) )
  TESTFUNC( void Six(char) )
  TESTFUNC( void Eight() )
};

struct IFive {
  TESTFUNC( void One() )
  virtual void Two() =0;
  TESTFUNC( void Three() )
  TESTFUNC( void Three(int) )
  TESTFUNC( void Three(float) )
  virtual void Four() =0;
  TESTFUNC( void Five() )
  virtual void Six() =0;
  virtual void Six(int) =0;
  virtual void Six(float) =0;
  TESTFUNC( void Seven() )
};

struct CFive: public IFive {
  TESTFUNC( void Two() )
  TESTFUNC( void Four() )
  TESTFUNC( void Six() )
  TESTFUNC( void Six(int) )
  TESTFUNC( void Six(float) )
};

int main() {
  new COne();
  new CTwo();
  new CThree();
  new CFour();
  new CFive();

  return 0;
}
